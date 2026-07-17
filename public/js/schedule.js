/* Kaylee's schedule view: passcode gate, grouped walks sorted by street,
   running earnings, and mark-done / cancel actions. */

(function () {
  const gate = document.getElementById('gate');
  const gateForm = document.getElementById('gate-form');
  const gateMsg = document.getElementById('gate-msg');
  const scheduleView = document.getElementById('schedule-view');
  const statsRow = document.getElementById('stats-row');
  const walksHolder = document.getElementById('walks');
  const refreshBtn = document.getElementById('refresh-btn');
  const lockBtn = document.getElementById('lock-btn');

  let passcode = sessionStorage.getItem('kaylee-passcode') || '';

  function dollars(cents) {
    return '$' + (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  }

  function friendlyDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-CA', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showGate(message) {
    gate.hidden = false;
    scheduleView.hidden = true;
    if (message) {
      gateMsg.textContent = message;
      gateMsg.hidden = false;
    } else {
      gateMsg.hidden = true;
    }
  }

  function api(path, options) {
    const opts = options || {};
    opts.headers = Object.assign({}, opts.headers, { 'x-passcode': passcode });
    return fetch(path, opts).then((res) =>
      res.json().then((body) => ({ status: res.status, ok: res.ok, body }))
    );
  }

  function renderStats(stats) {
    statsRow.innerHTML = '';
    const tiles = [
      [String(stats.walksThisWeek), 'walks this week'],
      [String(stats.walksThisMonth), 'walks this month'],
      [dollars(stats.earnedCents), 'earned in total'],
      [dollars(stats.upcomingCents), 'booked & upcoming'],
      [String(stats.completedWalks), 'walks completed'],
      [String(stats.dogsWalked), 'happy dogs walked'],
    ];
    for (const [num, lbl] of tiles) {
      const tile = el('div', 'stat-tile');
      tile.appendChild(el('div', 'num', num));
      tile.appendChild(el('div', 'lbl', lbl));
      statsRow.appendChild(tile);
    }
  }

  function updateWalk(ids, action, button) {
    const verb = action === 'done' ? 'mark this walk done' : 'cancel';
    if (action === 'cancel' && !window.confirm('Really ' + verb + '? This cannot be undone.')) {
      return;
    }
    button.disabled = true;
    const requests = ids.map((id) =>
      api('/api/bookings/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action }),
      })
    );
    Promise.all(requests)
      .then((results) => {
        const failed = results.find((r) => !r.ok);
        if (failed) {
          window.alert(failed.body.error || 'Something went wrong.');
        }
        loadSchedule();
      })
      .catch(() => {
        window.alert('Could not reach the server — try refreshing.');
        button.disabled = false;
      });
  }

  function renderWalk(walk) {
    const card = el('div', 'card walk-card');

    const head = el('div', 'walk-head');
    head.appendChild(el('div', 'walk-title', walk.slot + ' · ' + walk.duration + ' min walk'));
    head.appendChild(
      el('span', 'walk-status ' + walk.status, walk.status === 'done' ? 'Done' : 'Booked')
    );
    head.appendChild(el('div', 'walk-total', walk.totalCents ? dollars(walk.totalCents) : ''));
    card.appendChild(head);

    const route = walk.dogs.map((d) => d.street).filter(Boolean);
    if (route.length > 1) {
      card.appendChild(el('p', 'dog-sub', 'Route by street: ' + route.join(' → ')));
    }

    for (const dog of walk.dogs) {
      const row = el('div', 'dog-row' + (dog.status === 'done' ? ' done-row' : ''));
      const info = el('div');
      const main = el('div', 'dog-main', dog.dogName + ' (' + dog.dogSize + ')');
      if (dog.neighbourDiscount) {
        main.appendChild(el('span', 'discount-chip', 'neighbour group −$5'));
      }
      if (!dog.photoConsent) {
        main.appendChild(el('span', 'no-photos-chip', 'no photos'));
      }
      if (dog.referralDiscount) {
        main.appendChild(el('span', 'discount-chip', 'referral −$10'));
      }
      info.appendChild(main);
      info.appendChild(
        el('div', 'dog-sub', dog.ownerName + ' · ' + dog.phone + ' · ' + dog.address)
      );
      if (dog.notes) {
        info.appendChild(el('div', 'dog-sub', 'Note: ' + dog.notes));
      }
      row.appendChild(info);
      row.appendChild(el('div', 'dog-price', dollars(dog.priceCents)));

      if (dog.status !== 'done') {
        const cancelOne = el('button', 'btn btn-danger btn-small', 'Cancel dog');
        cancelOne.type = 'button';
        cancelOne.addEventListener('click', () => updateWalk([dog.id], 'cancel', cancelOne));
        row.appendChild(cancelOne);
      }
      card.appendChild(row);
    }

    if (walk.status !== 'done') {
      const actions = el('div', 'walk-actions');
      const ids = walk.dogs.filter((d) => d.status !== 'done').map((d) => d.id);

      const doneBtn = el('button', 'btn btn-primary btn-small', 'Mark walk done');
      doneBtn.type = 'button';
      doneBtn.addEventListener('click', () => updateWalk(ids, 'done', doneBtn));
      actions.appendChild(doneBtn);

      const cancelBtn = el('button', 'btn btn-danger btn-small', 'Cancel walk');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => updateWalk(ids, 'cancel', cancelBtn));
      actions.appendChild(cancelBtn);

      card.appendChild(actions);
    }

    return card;
  }

  function renderWalks(walks) {
    walksHolder.innerHTML = '';
    if (walks.length === 0) {
      const empty = el('p', 'hand', 'No walks booked yet — share the site with the neighbours!');
      empty.style.fontSize = '1.35rem';
      walksHolder.appendChild(empty);
      return;
    }
    let currentDate = '';
    for (const walk of walks) {
      if (walk.date !== currentDate) {
        currentDate = walk.date;
        walksHolder.appendChild(el('div', 'day-heading', friendlyDate(walk.date)));
      }
      walksHolder.appendChild(renderWalk(walk));
    }
  }

  let latestWalks = [];

  function loadSchedule() {
    api('/api/schedule')
      .then(({ status, ok, body }) => {
        if (status === 401) {
          sessionStorage.removeItem('kaylee-passcode');
          passcode = '';
          showGate('That passcode is not right — try again.');
          return;
        }
        if (!ok) {
          showGate(body.error || 'Something went wrong.');
          return;
        }
        sessionStorage.setItem('kaylee-passcode', passcode);
        gate.hidden = true;
        scheduleView.hidden = false;
        renderStats(body.stats);
        renderWalks(body.walks);
        latestWalks = body.walks;
        if (!document.getElementById('panel-calendar').hidden) renderCalendar();
        if (!siteConfig) loadConfig();
        // Coming back from the Google Calendar OAuth redirect: jump to the
        // Calendar tab and show the outcome.
        if (window.__gcalFlash) {
          const flash = window.__gcalFlash;
          window.__gcalFlash = null;
          const calTab = document.querySelector('.dash-tab[data-tab=calendar]');
          if (calTab) calTab.click();
          if (gcalMsg) {
            gcalMsg.textContent = flash;
            gcalMsg.className = 'form-msg ' + (flash.indexOf('connected') === 0 || flash.indexOf('Google Calendar connected') === 0 ? 'ok' : 'err');
            gcalMsg.hidden = false;
          }
        }
      })
      .catch(() => showGate('Could not reach the server — is it running?'));
  }

  // ----- tabs -----

  const dashTabs = document.querySelectorAll('.dash-tab');
  const dashPanels = {
    list: document.getElementById('panel-list'),
    calendar: document.getElementById('panel-calendar'),
    clients: document.getElementById('panel-clients'),
    payments: document.getElementById('panel-payments'),
    messages: document.getElementById('panel-messages'),
  };

  dashTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      dashTabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const target = tab.dataset.tab;
      Object.keys(dashPanels).forEach((key) => {
        dashPanels[key].hidden = key !== target;
      });
      if (target === 'calendar') { renderCalendar(); loadGcalStatus(); }
      if (target === 'clients') loadClients();
      if (target === 'payments') loadPaymentSettings();
      if (target === 'messages') loadMessages();
    });
  });

  // ----- calendar (week view) -----

  function startOfWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  function isoDate(d) {
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  }

  let weekStart = startOfWeek(new Date());
  const calRange = document.getElementById('cal-range');
  const calGrid = document.getElementById('cal-grid');

  function renderCalendar() {
    if (!calGrid) return;
    calGrid.innerHTML = '';
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    calRange.textContent =
      days[0].toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) +
      ' – ' +
      days[6].toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

    const todayIso = isoDate(new Date());
    const byDate = new Map();
    for (const w of latestWalks) {
      if (!byDate.has(w.date)) byDate.set(w.date, []);
      byDate.get(w.date).push(w);
    }

    for (const d of days) {
      const iso = isoDate(d);
      const cell = el('div', 'cal-day' + (iso === todayIso ? ' today' : ''));
      const head = el('div', 'cal-day-head');
      head.appendChild(document.createTextNode(d.toLocaleDateString('en-CA', { weekday: 'short' })));
      head.appendChild(el('strong', null, String(d.getDate())));
      cell.appendChild(head);

      const walksToday = (byDate.get(iso) || []).slice().sort((a, b) => slotIndexOf(a.slot) - slotIndexOf(b.slot));
      if (walksToday.length === 0) {
        cell.appendChild(el('div', 'dog-sub', '—'));
      }
      for (const w of walksToday) {
        const label = w.slot + ' · ' + w.dogs.length + (w.dogs.length === 1 ? ' dog' : ' dogs');
        cell.appendChild(el('div', 'cal-walk' + (w.status === 'done' ? ' done' : ''), label));
      }
      calGrid.appendChild(cell);
    }
  }

  function slotIndexOf(slot) {
    const order = ['7:00 AM', '9:00 AM', '11:00 AM', '1:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM'];
    return order.indexOf(slot);
  }

  const calPrev = document.getElementById('cal-prev');
  const calNext = document.getElementById('cal-next');
  if (calPrev) {
    calPrev.addEventListener('click', () => {
      weekStart.setDate(weekStart.getDate() - 7);
      renderCalendar();
    });
  }
  if (calNext) {
    calNext.addEventListener('click', () => {
      weekStart.setDate(weekStart.getDate() + 7);
      renderCalendar();
    });
  }

  // ----- clients (CRM) -----

  function loadClients() {
    const holder = document.getElementById('clients-list');
    api('/api/clients')
      .then(({ ok, body }) => {
        if (!ok) {
          holder.innerHTML = '';
          holder.appendChild(el('p', 'hint', body.error || 'Could not load clients.'));
          return;
        }
        renderClients(body.clients);
      })
      .catch(() => {
        holder.innerHTML = '';
        holder.appendChild(el('p', 'hint', 'Could not reach the server — try refreshing.'));
      });
  }

  function updateClientTags(id, tags) {
    api('/api/clients/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: tags }),
    })
      .then(({ ok }) => {
        if (!ok) {
          window.alert('Could not update tags — please try again.');
          return;
        }
        loadClients();
      })
      .catch(() => window.alert('Could not reach the server — try refreshing.'));
  }

  function renderClientCard(c) {
    const card = el('div', 'card client-card');
    card.appendChild(el('div', 'client-name', c.ownerName + ' · ' + c.dogName));
    card.appendChild(el('div', 'client-sub', c.phone + (c.email ? ' · ' + c.email : '') + ' · ' + c.address));
    if (c.dogBirthday) {
      card.appendChild(el('div', 'client-sub', '🎂 ' + c.dogBirthday));
    }
    card.appendChild(
      el(
        'div',
        'client-sub',
        c.bookingCount + ' booking(s), ' + c.completedCount + ' completed · referral code ' + c.referralCode
      )
    );
    if (c.pendingCreditCents) {
      card.appendChild(el('div', 'client-credit', '$' + (c.pendingCreditCents / 100).toFixed(0) + ' referral credit owed'));
    }
    if (c.paused) {
      card.appendChild(el('div', 'client-credit', '⏸ Account paused — away for now'));
    }

    const tagRow = el('div', 'tag-row');
    (c.tags || []).forEach((tag) => {
      const chip = el('span', 'tag-chip');
      chip.appendChild(document.createTextNode(tag));
      const rm = el('button', null, '✕');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove tag ' + tag);
      rm.addEventListener('click', () => updateClientTags(c.id, c.tags.filter((t) => t !== tag)));
      chip.appendChild(rm);
      tagRow.appendChild(chip);
    });
    card.appendChild(tagRow);

    const tagAdd = el('div', 'tag-add');
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.placeholder = 'add tag (e.g. regular)';
    const tagBtn = el('button', 'btn btn-quiet btn-small', 'Add');
    tagBtn.type = 'button';
    tagBtn.addEventListener('click', () => {
      const v = tagInput.value.trim();
      if (!v) return;
      updateClientTags(c.id, (c.tags || []).concat([v]));
      tagInput.value = '';
    });
    tagAdd.appendChild(tagInput);
    tagAdd.appendChild(tagBtn);
    card.appendChild(tagAdd);

    card.appendChild(el('label', null, 'Notes'));
    const notesArea = document.createElement('textarea');
    notesArea.value = c.notes || '';
    card.appendChild(notesArea);
    const saveBtn = el('button', 'btn btn-primary btn-small', 'Save notes');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true;
      api('/api/clients/' + c.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesArea.value }),
      })
        .then(({ ok }) => {
          saveBtn.textContent = ok ? 'Saved ✓' : 'Failed — retry';
          setTimeout(() => (saveBtn.textContent = 'Save notes'), 1500);
        })
        .catch(() => {
          saveBtn.textContent = 'Failed — retry';
          setTimeout(() => (saveBtn.textContent = 'Save notes'), 1500);
        })
        .finally(() => {
          saveBtn.disabled = false;
        });
    });
    card.appendChild(saveBtn);

    if (c.upcoming && c.upcoming.length) {
      card.appendChild(el('div', 'client-sub', 'Upcoming: ' + c.upcoming.map((b) => b.date + ' ' + b.slot).join(', ')));
    }
    return card;
  }

  function renderClients(clientList) {
    const holder = document.getElementById('clients-list');
    holder.innerHTML = '';
    if (clientList.length === 0) {
      holder.appendChild(el('p', 'hand', 'No clients yet.'));
      return;
    }
    const sorted = clientList.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    sorted.forEach((c) => holder.appendChild(renderClientCard(c)));
  }

  // ----- payment preferences -----

  const paymentSubs = {
    etransfer: 'Standard for most bookings',
    cash: 'Paid directly at the walk',
    stripe: 'Placeholder — needs a real Stripe account connected before this can actually charge cards',
  };

  function loadPaymentSettings() {
    const holder = document.getElementById('payment-toggles');
    api('/api/settings/payment-methods')
      .then(({ ok, body }) => {
        if (!ok) {
          holder.innerHTML = '';
          holder.appendChild(el('p', 'hint', body.error || 'Could not load payment settings.'));
          return;
        }
        renderPaymentToggles(body.paymentMethods, body.labels);
      })
      .catch(() => {
        holder.innerHTML = '';
        holder.appendChild(el('p', 'hint', 'Could not reach the server — try refreshing.'));
      });
  }

  function renderPaymentToggles(methods, labels) {
    const holder = document.getElementById('payment-toggles');
    holder.innerHTML = '';
    Object.keys(labels).forEach((key) => {
      const row = el('div', 'toggle-row');
      const left = el('div');
      left.appendChild(el('div', 'toggle-label', labels[key]));
      left.appendChild(el('div', 'toggle-sub', paymentSubs[key] || ''));
      row.appendChild(left);

      const switchLabel = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!methods[key];
      input.addEventListener('change', () => {
        const desired = input.checked;
        input.disabled = true;
        const patch = {};
        patch[key] = desired;
        api('/api/settings/payment-methods', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(({ ok }) => {
            if (!ok) {
              input.checked = !desired; // revert on failure so the UI matches reality
              window.alert('Could not save that — please try again.');
            }
          })
          .catch(() => {
            input.checked = !desired;
            window.alert('Could not reach the server — try again.');
          })
          .finally(() => {
            input.disabled = false;
          });
      });
      switchLabel.appendChild(input);
      switchLabel.appendChild(el('span', 'slider'));
      row.appendChild(switchLabel);
      holder.appendChild(row);
    });
  }

  // ----- messages: notification log + email templates + send -----

  function renderLogEntries(holder, entries, metaFn, bodyFn, emptyText) {
    holder.innerHTML = '';
    if (entries.length === 0) {
      holder.appendChild(el('p', 'hint', emptyText));
      return;
    }
    entries.slice(0, 40).forEach((entry) => {
      const item = el('div', 'notif-entry');
      const meta = el('div', 'notif-meta');
      meta.appendChild(el('span', null, metaFn(entry)));
      meta.appendChild(el('span', 'notif-status', entry.status.split(' —')[0]));
      item.appendChild(meta);
      item.appendChild(el('div', null, bodyFn(entry)));
      holder.appendChild(item);
    });
  }

  function loadNotifications() {
    const holder = document.getElementById('notif-log');
    api('/api/notifications')
      .then(({ ok, body }) => {
        if (!ok) {
          holder.innerHTML = '';
          holder.appendChild(el('p', 'hint', body.error || 'Could not load the notification log.'));
          return;
        }
        renderLogEntries(
          holder,
          body.notifications,
          (n) => n.type + ' → ' + n.to,
          (n) => n.message,
          'Nothing queued yet.'
        );
      })
      .catch(() => {
        holder.innerHTML = '';
        holder.appendChild(el('p', 'hint', 'Could not reach the server — try refreshing.'));
      });
  }

  function loadEmailLog() {
    const holder = document.getElementById('email-log');
    api('/api/email-log')
      .then(({ ok, body }) => {
        if (!ok) {
          holder.innerHTML = '';
          holder.appendChild(el('p', 'hint', body.error || 'Could not load the sent log.'));
          return;
        }
        renderLogEntries(
          holder,
          body.log,
          (e) => 'To: ' + e.to,
          (e) => e.subject,
          'No emails queued yet.'
        );
      })
      .catch(() => {
        holder.innerHTML = '';
        holder.appendChild(el('p', 'hint', 'Could not reach the server — try refreshing.'));
      });
  }

  function renderEmailTemplates(templates) {
    const holder = document.getElementById('email-templates');
    holder.innerHTML = '';
    templates.forEach((t) => {
      const card = el('div', 'card email-template-card');
      card.appendChild(el('div', 'client-name', t.name));
      const subjInput = document.createElement('input');
      subjInput.value = t.subject;
      card.appendChild(subjInput);
      const bodyArea = document.createElement('textarea');
      bodyArea.value = t.body;
      card.appendChild(bodyArea);
      const saveBtn = el('button', 'btn btn-quiet btn-small', 'Save template');
      saveBtn.type = 'button';
      saveBtn.addEventListener('click', () => {
        saveBtn.disabled = true;
        api('/api/email-templates/' + t.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: subjInput.value, body: bodyArea.value }),
        })
          .then(({ ok }) => {
            saveBtn.textContent = ok ? 'Saved ✓' : 'Failed — retry';
            setTimeout(() => (saveBtn.textContent = 'Save template'), 1500);
          })
          .catch(() => {
            saveBtn.textContent = 'Failed — retry';
            setTimeout(() => (saveBtn.textContent = 'Save template'), 1500);
          })
          .finally(() => {
            saveBtn.disabled = false;
          });
      });
      card.appendChild(saveBtn);
      holder.appendChild(card);
    });
  }

  function loadEmailTemplates() {
    const select = document.getElementById('email-template-select');
    api('/api/email-templates')
      .then(({ ok, body }) => {
        if (!ok) return;
        renderEmailTemplates(body.templates);
        select.innerHTML = '';
        body.templates.forEach((t) => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name;
          select.appendChild(opt);
        });
      })
      .catch(() => {
        document.getElementById('email-templates').innerHTML = '';
        document
          .getElementById('email-templates')
          .appendChild(el('p', 'hint', 'Could not load templates — try refreshing.'));
      });
  }

  function loadClientsForRecipients() {
    const holder = document.getElementById('email-recipients');
    api('/api/clients')
      .then(({ ok, body }) => {
        if (!ok) {
          holder.innerHTML = '';
          holder.appendChild(el('p', 'hint', body.error || 'Could not load clients.'));
          return;
        }
        holder.innerHTML = '';
        if (body.clients.length === 0) {
          holder.appendChild(el('p', 'hint', 'No clients yet.'));
          return;
        }
        body.clients.forEach((c) => {
          const label = document.createElement('label');
          label.className = 'recipient-chip';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = c.id;
          cb.style.margin = '0';
          label.appendChild(cb);
          label.appendChild(
            document.createTextNode(c.ownerName + ' (' + c.dogName + ')' + (c.paused ? ' — paused' : ''))
          );
          holder.appendChild(label);
        });
      })
      .catch(() => {
        holder.innerHTML = '';
        holder.appendChild(el('p', 'hint', 'Could not reach the server — try refreshing.'));
      });
  }

  function loadMessages() {
    loadNotifications();
    loadEmailTemplates();
    loadEmailLog();
    loadClientsForRecipients();
  }

  const emailSendBtn = document.getElementById('email-send-btn');
  if (emailSendBtn) {
    emailSendBtn.addEventListener('click', () => {
      const templateId = document.getElementById('email-template-select').value;
      const checked = Array.from(document.querySelectorAll('#email-recipients input:checked')).map((i) => i.value);
      const msgEl = document.getElementById('email-send-msg');
      if (checked.length === 0) {
        msgEl.textContent = 'Select at least one recipient.';
        msgEl.className = 'form-msg err';
        msgEl.hidden = false;
        return;
      }
      emailSendBtn.disabled = true;
      api('/api/emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: templateId, clientIds: checked }),
      })
        .then(({ ok, body }) => {
          msgEl.textContent = ok
            ? 'Queued ' + body.queued + ' email(s) — not actually sent yet (no email provider connected).'
            : body.error || 'Something went wrong.';
          msgEl.className = 'form-msg ' + (ok ? 'ok' : 'err');
          msgEl.hidden = false;
          if (ok) loadEmailLog();
        })
        .catch(() => {
          msgEl.textContent = 'Could not reach the server — please try again.';
          msgEl.className = 'form-msg err';
          msgEl.hidden = false;
        })
        .finally(() => {
          emailSendBtn.disabled = false;
        });
    });
  }

  // ----- shared config for the admin forms -----

  let siteConfig = null;
  function loadConfig() {
    return fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        siteConfig = cfg;
        fillAdminSelects();
      })
      .catch(() => {});
  }

  function fillOptions(select, items, makeOption, placeholderText) {
    if (!select) return;
    select.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholderText || 'Choose…';
    if (placeholderText !== 'none-required') select.appendChild(ph);
    items.forEach((item) => select.appendChild(makeOption(item)));
  }

  function fillAdminSelects() {
    if (!siteConfig) return;
    const sizeOpt = (s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; return o; };
    fillOptions(document.getElementById('aw-size'), siteConfig.dogSizes, sizeOpt);
    fillOptions(document.getElementById('ac-size'), siteConfig.dogSizes, sizeOpt);
    fillOptions(document.getElementById('aw-slot'), siteConfig.slots, sizeOpt);
    fillOptions(
      document.getElementById('aw-duration'),
      siteConfig.durations,
      (d) => {
        const o = document.createElement('option');
        o.value = String(d.minutes);
        o.textContent = d.minutes + ' minutes — ' + dollars(d.priceCents);
        return o;
      }
    );
    const awDate = document.getElementById('aw-date');
    if (awDate) awDate.min = new Date().toISOString().slice(0, 10);
  }

  // ----- admin: add a walk manually -----

  const adminWalkForm = document.getElementById('admin-walk-form');
  if (adminWalkForm) {
    adminWalkForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const msgEl = document.getElementById('aw-msg');
      const btn = adminWalkForm.querySelector('button[type=submit]');
      btn.disabled = true;
      api('/api/admin/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerName: document.getElementById('aw-owner').value.trim(),
          phone: document.getElementById('aw-phone').value.trim(),
          dogName: document.getElementById('aw-dog').value.trim(),
          dogSize: document.getElementById('aw-size').value,
          address: document.getElementById('aw-address').value.trim(),
          date: document.getElementById('aw-date').value,
          slot: document.getElementById('aw-slot').value,
          duration: Number(document.getElementById('aw-duration').value),
          notes: document.getElementById('aw-notes').value.trim(),
        }),
      })
        .then(({ ok, body }) => {
          msgEl.textContent = ok ? 'Walk added! ' + (body.note || '') : body.error || 'Could not add the walk.';
          msgEl.className = 'form-msg ' + (ok ? 'ok' : 'err');
          msgEl.hidden = false;
          if (ok) {
            adminWalkForm.reset();
            fillAdminSelects();
            loadSchedule();
          }
        })
        .catch(() => {
          msgEl.textContent = 'Could not reach the server — please try again.';
          msgEl.className = 'form-msg err';
          msgEl.hidden = false;
        })
        .finally(() => { btn.disabled = false; });
    });
  }

  // ----- admin: add a client manually -----

  const adminClientForm = document.getElementById('admin-client-form');
  if (adminClientForm) {
    adminClientForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const msgEl = document.getElementById('ac-msg');
      const btn = adminClientForm.querySelector('button[type=submit]');
      btn.disabled = true;
      api('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerName: document.getElementById('ac-owner').value.trim(),
          phone: document.getElementById('ac-phone').value.trim(),
          email: document.getElementById('ac-email').value.trim(),
          dogName: document.getElementById('ac-dog').value.trim(),
          dogSize: document.getElementById('ac-size').value,
          address: document.getElementById('ac-address').value.trim(),
          notes: document.getElementById('ac-notes').value.trim(),
        }),
      })
        .then(({ ok, body }) => {
          msgEl.textContent = ok ? 'Client added!' : body.error || 'Could not add the client.';
          msgEl.className = 'form-msg ' + (ok ? 'ok' : 'err');
          msgEl.hidden = false;
          if (ok) {
            adminClientForm.reset();
            fillAdminSelects();
            loadClients();
          }
        })
        .catch(() => {
          msgEl.textContent = 'Could not reach the server — please try again.';
          msgEl.className = 'form-msg err';
          msgEl.hidden = false;
        })
        .finally(() => { btn.disabled = false; });
    });
  }

  // ----- Google Calendar panel -----

  const gcalStatusText = document.getElementById('gcal-status-text');
  const gcalConnectBtn = document.getElementById('gcal-connect-btn');
  const gcalSyncBtn = document.getElementById('gcal-sync-btn');
  const gcalDisconnectBtn = document.getElementById('gcal-disconnect-btn');
  const gcalMsg = document.getElementById('gcal-msg');

  function loadGcalStatus() {
    if (!gcalStatusText) return;
    api('/api/gcal/status')
      .then(({ ok, body }) => {
        if (!ok) {
          gcalStatusText.textContent = body.error || 'Could not check the Google Calendar connection.';
          return;
        }
        gcalConnectBtn.hidden = true;
        gcalSyncBtn.hidden = true;
        gcalDisconnectBtn.hidden = true;
        if (!body.configured) {
          gcalStatusText.textContent =
            'Not configured yet: this needs Google Cloud credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) with the Calendar API enabled — see the README. Nothing here is faked: once the credentials are set, Connect appears and every booking syncs to your real calendar.';
          return;
        }
        if (!body.connected) {
          gcalStatusText.textContent =
            'Ready to connect. You’ll be sent to Google to allow calendar access, then every new booking creates an event automatically.';
          gcalConnectBtn.hidden = false;
          gcalConnectBtn.href = '/api/gcal/connect?passcode=' + encodeURIComponent(passcode);
          return;
        }
        gcalStatusText.textContent =
          'Connected as ' + (body.email || 'your Google account') +
          (body.lastSyncAt ? ' · last synced ' + new Date(body.lastSyncAt).toLocaleString('en-CA') : '') +
          (body.lastError ? ' · last error: ' + body.lastError : '') +
          '. Walks sync both ways: bookings create events, and deleting or moving an event in Google Calendar updates the walk here on the next sync.';
        gcalSyncBtn.hidden = false;
        gcalDisconnectBtn.hidden = false;
      })
      .catch(() => {
        gcalStatusText.textContent = 'Could not reach the server.';
      });
  }

  if (gcalSyncBtn) {
    gcalSyncBtn.addEventListener('click', () => {
      gcalSyncBtn.disabled = true;
      gcalSyncBtn.textContent = 'Syncing…';
      api('/api/gcal/sync', { method: 'POST' })
        .then(({ ok, body }) => {
          if (ok) {
            const s = body.summary || {};
            gcalMsg.textContent =
              'Synced — ' + (s.created || 0) + ' event(s) created, ' +
              (s.movedFromCalendar || 0) + ' walk(s) moved from calendar, ' +
              (s.cancelledFromCalendar || 0) + ' cancelled from calendar, ' +
              (s.pushedBack || 0) + ' pushed back to calendar.';
            gcalMsg.className = 'form-msg ok';
            loadSchedule();
          } else {
            gcalMsg.textContent = body.error || 'Sync failed.';
            gcalMsg.className = 'form-msg err';
          }
          gcalMsg.hidden = false;
          loadGcalStatus();
        })
        .catch(() => {
          gcalMsg.textContent = 'Could not reach the server.';
          gcalMsg.className = 'form-msg err';
          gcalMsg.hidden = false;
        })
        .finally(() => {
          gcalSyncBtn.disabled = false;
          gcalSyncBtn.textContent = 'Sync now';
        });
    });
  }

  if (gcalDisconnectBtn) {
    gcalDisconnectBtn.addEventListener('click', () => {
      if (!window.confirm('Disconnect Google Calendar? Existing events stay on your calendar but stop syncing.')) return;
      api('/api/gcal/disconnect', { method: 'POST' }).then(() => loadGcalStatus());
    });
  }

  // Surface the result of an OAuth redirect (?gcal=connected / failed / ...).
  (function () {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('gcal');
    if (!flag) return;
    history.replaceState(null, '', '/schedule.html');
    const messages = {
      connected: 'Google Calendar connected! Your upcoming walks are syncing now.',
      failed: 'Google Calendar connection failed — please try again.',
      state_error: 'Google Calendar connection could not be verified — please try again.',
      unavailable: 'Google Calendar is not configured on the server yet.',
    };
    window.__gcalFlash = messages[flag] || null;
  })();

  gateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    passcode = gateForm.passcode.value;
    loadSchedule();
  });

  refreshBtn.addEventListener('click', loadSchedule);

  const backupBtn = document.getElementById('backup-btn');
  if (backupBtn) {
    backupBtn.addEventListener('click', () => {
      backupBtn.disabled = true;
      backupBtn.textContent = 'Preparing…';
      fetch('/api/export', { headers: { 'x-passcode': passcode } })
        .then((res) => {
          if (!res.ok) throw new Error('export failed');
          return res.blob();
        })
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const stamp = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = 'kaylees-dog-walking-backup-' + stamp + '.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        })
        .catch(() => window.alert('Could not download the backup — please try again.'))
        .finally(() => {
          backupBtn.disabled = false;
          backupBtn.textContent = 'Download backup';
        });
    });
  }

  lockBtn.addEventListener('click', () => {
    sessionStorage.removeItem('kaylee-passcode');
    passcode = '';
    gateForm.reset();
    showGate();
  });

  if (passcode) {
    loadSchedule();
  } else {
    showGate();
  }
})();

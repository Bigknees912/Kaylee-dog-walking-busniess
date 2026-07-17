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
      [dollars(stats.earnedCents), 'earned so far'],
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
      dashTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      Object.keys(dashPanels).forEach((key) => {
        dashPanels[key].hidden = key !== target;
      });
      if (target === 'calendar') renderCalendar();
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
    api('/api/clients').then(({ ok, body }) => {
      if (!ok) return;
      renderClients(body.clients);
    });
  }

  function updateClientTags(id, tags) {
    api('/api/clients/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: tags }),
    }).then(() => loadClients());
  }

  function renderClientCard(c) {
    const card = el('div', 'card client-card');
    card.appendChild(el('div', 'client-name', c.ownerName + ' · ' + c.dogName));
    card.appendChild(el('div', 'client-sub', c.phone + ' · ' + c.address));
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
      api('/api/clients/' + c.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesArea.value }),
      }).then(() => {
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => (saveBtn.textContent = 'Save notes'), 1200);
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
    api('/api/settings/payment-methods').then(({ ok, body }) => {
      if (!ok) return;
      renderPaymentToggles(body.paymentMethods, body.labels);
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
        const patch = {};
        patch[key] = input.checked;
        api('/api/settings/payment-methods', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
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
    api('/api/notifications').then(({ ok, body }) => {
      if (!ok) return;
      renderLogEntries(
        document.getElementById('notif-log'),
        body.notifications,
        (n) => n.type + ' → ' + n.to,
        (n) => n.message,
        'Nothing queued yet.'
      );
    });
  }

  function loadEmailLog() {
    api('/api/email-log').then(({ ok, body }) => {
      if (!ok) return;
      renderLogEntries(
        document.getElementById('email-log'),
        body.log,
        (e) => 'To: ' + e.to,
        (e) => e.subject,
        'No emails queued yet.'
      );
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
        api('/api/email-templates/' + t.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: subjInput.value, body: bodyArea.value }),
        }).then(() => {
          saveBtn.textContent = 'Saved ✓';
          setTimeout(() => (saveBtn.textContent = 'Save template'), 1200);
        });
      });
      card.appendChild(saveBtn);
      holder.appendChild(card);
    });
  }

  function loadEmailTemplates() {
    api('/api/email-templates').then(({ ok, body }) => {
      if (!ok) return;
      renderEmailTemplates(body.templates);
      const select = document.getElementById('email-template-select');
      select.innerHTML = '';
      body.templates.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        select.appendChild(opt);
      });
    });
  }

  function loadClientsForRecipients() {
    api('/api/clients').then(({ ok, body }) => {
      if (!ok) return;
      const holder = document.getElementById('email-recipients');
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
        label.appendChild(document.createTextNode(c.ownerName + ' (' + c.dogName + ')'));
        holder.appendChild(label);
      });
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
      api('/api/emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: templateId, clientIds: checked }),
      }).then(({ ok, body }) => {
        msgEl.textContent = ok
          ? 'Queued ' + body.queued + ' email(s) — not actually sent yet (no email provider connected).'
          : body.error || 'Something went wrong.';
        msgEl.className = 'form-msg ' + (ok ? 'ok' : 'err');
        msgEl.hidden = false;
        if (ok) loadEmailLog();
      });
    });
  }

  gateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    passcode = gateForm.passcode.value;
    loadSchedule();
  });

  refreshBtn.addEventListener('click', loadSchedule);

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

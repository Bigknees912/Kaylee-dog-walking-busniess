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
      if (dog.photoOptOut) {
        main.appendChild(el('span', 'no-photos-chip', 'no photos'));
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
      })
      .catch(() => showGate('Could not reach the server — is it running?'));
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

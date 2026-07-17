/* Booking form: pulls slots, sizes and prices from the server so the form
   always matches what Kaylee actually offers, looks up returning clients
   by phone to autofill their dog's details, and submits the booking. */

(function () {
  const form = document.getElementById('booking-form');
  const msg = document.getElementById('form-msg');
  const slotSelect = document.getElementById('slot');
  const sizeSelect = document.getElementById('dogSize');
  const durationSelect = document.getElementById('duration');
  const dateInput = document.getElementById('date');
  const phoneInput = document.getElementById('phone');
  const submitBtn = document.getElementById('submit-btn');
  const returningHint = document.getElementById('returning-hint');
  const paymentNote = document.getElementById('payment-methods-note');
  const paymentList = document.getElementById('payment-methods-list');

  function dollars(cents) {
    return '$' + (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  }

  function showMessage(text, ok) {
    msg.textContent = text;
    msg.className = 'form-msg ' + (ok ? 'ok' : 'err');
    msg.hidden = false;
  }

  function fillSelect(select, items, makeOption) {
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose…';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.defaultSelected = true;
    select.appendChild(placeholder);
    for (const item of items) {
      select.appendChild(makeOption(item));
    }
  }

  // Earliest bookable date is today.
  const now = new Date();
  const today =
    now.getFullYear() +
    '-' +
    String(now.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getDate()).padStart(2, '0');
  dateInput.min = today;

  fetch('/api/config')
    .then((res) => {
      if (!res.ok) throw new Error('config unavailable');
      return res.json();
    })
    .then((config) => {
      fillSelect(slotSelect, config.slots, (slot) => {
        const opt = document.createElement('option');
        opt.value = slot;
        opt.textContent = slot;
        return opt;
      });
      fillSelect(sizeSelect, config.dogSizes, (size) => {
        const opt = document.createElement('option');
        opt.value = size;
        opt.textContent = size;
        return opt;
      });
      fillSelect(durationSelect, config.durations, (d) => {
        const opt = document.createElement('option');
        opt.value = String(d.minutes);
        opt.textContent = d.minutes + ' minutes — ' + dollars(d.priceCents);
        return opt;
      });

      if (config.paymentMethods && config.paymentMethods.length > 0) {
        paymentList.textContent = config.paymentMethods.map((m) => m.label).join(', ');
        paymentNote.hidden = false;
      }
    })
    .catch(() => {
      showMessage(
        'Hmm, the booking form could not load. Please refresh, or text Kaylee at 587-433-2199.',
        false
      );
      submitBtn.disabled = true;
    });

  // Returning-client lookup: once a phone number looks complete, check if
  // we already know this owner and fill in their dog's details for them.
  let lastLookedUp = '';
  function lookupReturningClient() {
    const phone = phoneInput.value.trim();
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || phone === lastLookedUp) return;
    lastLookedUp = phone;

    fetch('/api/clients/lookup?phone=' + encodeURIComponent(phone))
      .then((res) => res.json())
      .then((data) => {
        if (!data.found) return;
        if (!form.ownerName.value.trim()) form.ownerName.value = data.ownerName || '';
        if (!form.dogName.value.trim()) form.dogName.value = data.dogName || '';
        if (!form.address.value.trim()) form.address.value = data.address || '';
        if (!form.dogSize.value && data.dogSize) form.dogSize.value = data.dogSize;
        if (!form.email.value.trim()) form.email.value = data.email || '';
        if (!form.dogBirthday.value.trim()) form.dogBirthday.value = data.dogBirthday || '';
        returningHint.hidden = false;
      })
      .catch(() => {});
  }
  phoneInput.addEventListener('blur', lookupReturningClient);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    msg.hidden = true;

    if (!form.vaccinatedAgreed.checked || !form.waiverAgreed.checked) {
      showMessage('Please check both required boxes above (vaccination/temperament and the waiver) before booking.', false);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Booking…';

    const payload = {
      ownerName: form.ownerName.value.trim(),
      dogName: form.dogName.value.trim(),
      dogSize: form.dogSize.value,
      phone: form.phone.value.trim(),
      email: form.email.value.trim(),
      address: form.address.value.trim(),
      date: form.date.value,
      slot: form.slot.value,
      duration: Number(form.duration.value),
      notes: form.notes.value.trim(),
      dogBirthday: form.dogBirthday.value.trim(),
      referralCode: form.referralCode.value.trim(),
      vaccinatedAgreed: form.vaccinatedAgreed.checked,
      waiverAgreed: form.waiverAgreed.checked,
      photoConsent: form.photoConsent.checked,
    };

    fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (ok) {
          showMessage(body.message || "You're booked!", true);
          form.reset();
          dateInput.min = today;
          returningHint.hidden = true;
          lastLookedUp = '';
        } else {
          showMessage(body.error || 'Something went wrong — please try again.', false);
        }
      })
      .catch(() => {
        showMessage(
          'Could not reach the booking system. Please try again, or text Kaylee at 587-433-2199.',
          false
        );
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Book my walk';
      });
  });
})();

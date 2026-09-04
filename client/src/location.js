/**
 * Where the meeting happened, from a browser. P3-10.
 *
 * The server has held this since the geolocation work: `/activities/meta` says
 * whether capture is wanted, for which meeting modes, and what notice to show,
 * and `POST /activities` accepts a `geo`. The mobile app has used it from the
 * start. The web form never sent one — so an RM logging a client visit from a
 * laptop recorded no location, and the feature read as missing because from the
 * web it was.
 *
 * WHAT HAPPENS WHEN IT FAILS
 * --------------------------
 * Ritesh settled this on 4 Sep: the activity saves regardless, and the reason
 * there is no position is recorded with it. An RM standing outside a client's
 * office with location switched off still needs the meeting logged, and a form
 * that refuses would simply teach people to log meetings from their desk
 * afterwards — which is worse evidence than an honest "declined".
 *
 * So this never throws and never rejects. Every path returns a status the
 * server understands.
 */

/** How long to wait before giving up. */
const TIMEOUT_MS = 8000;

/**
 * A position, or an honest reason there isn't one.
 *
 * `declined` and `unavailable` are kept apart because they mean different
 * things to whoever reads the record later: one is a person's choice, the other
 * is a device or a basement.
 */
export function capture() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ status: 'unavailable' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    /* Our own timer as well as the browser's. `timeout` is not honoured
       consistently once a permission prompt is on screen — some browsers hold
       the callback until the person answers — and a Save button that waits
       forever on a dialog somebody has walked away from is worse than no
       location. */
    const timer = setTimeout(() => done({ status: 'unavailable' }), TIMEOUT_MS + 1000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({
          status: 'captured',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
        });
      },
      (err) => {
        clearTimeout(timer);
        // 1 is PERMISSION_DENIED; 2 and 3 are position-unavailable and timeout.
        done({ status: err?.code === 1 ? 'declined' : 'unavailable' });
      },
      { enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: 60000 },
    );
  });
}

/** What to tell the person about a captured position, or the lack of one. */
export function describe(geo) {
  if (!geo) return null;
  if (geo.status === 'declined') return 'Location was not shared, and the meeting was saved without one.';
  if (geo.status === 'unavailable') return 'No location was available, and the meeting was saved without one.';

  const accuracy = Number.isFinite(geo.accuracy_m) ? ` (±${Math.round(geo.accuracy_m)} m)` : '';
  return `Location captured${accuracy}.`;
}

/**
 * Does this activity want a location?
 *
 * The server decides, and says so in `/activities/meta` — capture is on or off
 * for the deployment, and applies to the physical meeting modes only. A phone
 * call has no place to be.
 */
export const wants = (meta, type, mode) => Boolean(
  meta?.geolocation?.enabled
  && type === 'Meeting'
  && mode
  && (meta.geolocation.modes ?? []).includes(mode),
);

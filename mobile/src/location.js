/**
 * A position for an in-person meeting.
 *
 * The server already draws the distinctions that matter and the tests in
 * `server/test/geolocation.test.mjs` hold them: a refusal is a value rather
 * than a failure, "would not give one" is told apart from "could not get one",
 * and the accuracy radius is kept because an address on its own would mislead.
 *
 * This file's only job is to produce those values honestly. It must never
 * report `captured` for a position it did not get, and it must never block the
 * save -- an unlogged meeting is worse for the business than an unlocated one,
 * which is the whole reason `declined` exists as a stored value.
 */

import * as Location from 'expo-location';

/** Shapes match `geolocation.normalise` on the server. */
const DECLINED = { status: 'declined' };
const UNAVAILABLE = { status: 'unavailable' };

export async function capture() {
  let permission;
  try {
    permission = await Location.requestForegroundPermissionsAsync();
  } catch {
    // The permission dialogue itself failed -- not a refusal by the person.
    return UNAVAILABLE;
  }

  if (!permission?.granted) return DECLINED;

  let fix;
  try {
    fix = await Location.getCurrentPositionAsync({
      /* High is about 10m; Balanced, the default, is about 100m. The radius is
         stored and shown beside the address, so a 100m circle around "their
         office" would be visibly weak the moment anyone leaned on it. The cost
         is a slower fix and more battery, which is the right trade for a few
         captures a day. */
      accuracy: Location.Accuracy.High,
    });
  } catch {
    // Permission given, no fix: indoors, a basement, airplane mode.
    return UNAVAILABLE;
  }

  const { latitude, longitude, accuracy } = fix?.coords ?? {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return UNAVAILABLE;

  /* Reverse geocoding is a nicety and must not turn a good fix into a failure,
     so its own errors are swallowed and the coordinates stand alone. */
  let address = null;
  try {
    const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (place) {
      address = [place.name, place.street, place.city, place.region, place.postalCode]
        .filter(Boolean).join(', ') || null;
    }
  } catch { /* keep the coordinates */ }

  return {
    status: 'captured',
    lat: latitude,
    lng: longitude,
    accuracy_m: accuracy == null ? null : Math.round(accuracy),
    address,
  };
}

/** What to show once a capture has been attempted. */
export const describe = (geo) => {
  if (!geo) return 'Not captured yet.';
  if (geo.status === 'declined') return 'Location permission refused. The meeting will still be saved.';
  if (geo.status === 'unavailable') return 'No position available here. The meeting will still be saved.';
  const radius = geo.accuracy_m == null ? '' : ` · accurate to about ${geo.accuracy_m} m`;
  return `${geo.address || `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`}${radius}`;
};

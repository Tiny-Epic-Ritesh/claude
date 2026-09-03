import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
} from 'react-native';
import * as queue from '../queue.js';
import { capture, describe } from '../location.js';
import { s, t } from '../theme.js';

/**
 * Log a meeting against a lead.
 *
 * Every choice on this form comes from `GET /api/activities/meta` -- the modes,
 * the outcomes, whether a location is wanted at all, and the notice shown while
 * it is asked for. Nothing here is hardcoded, so turning capture on or adding an
 * outcome in Setup changes this screen without it being rebuilt.
 */
export default function LogMeeting({ lead, onDone, onCancel }) {
  const [meta, setMeta] = useState(null);
  const [mode, setMode] = useState(null);
  const [code, setCode] = useState(null);
  const [notes, setNotes] = useState('');
  const [geo, setGeo] = useState(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/activities/meta')
      .then((m) => { setMeta(m); setMode(m.meeting_modes?.[0] ?? null); })
      .catch((err) => setError(err.message));
  }, []);

  const wantsLocation = !!meta?.geolocation?.enabled && meta.geolocation.modes?.includes(mode);

  const getLocation = async () => {
    setLocating(true);
    setGeo(await capture());
    setLocating(false);
  };

  /**
   * Queue first, then send.
   *
   * Writing to the queue before attempting the network means the meeting
   * survives the app being killed mid-send, a phone running out of battery in a
   * car park, and a tunnel. The flush that follows is what gets it there now if
   * there is signal -- and its result is what decides the wording, because a rep
   * needs to know whether this is done or merely safe.
   */
  const submit = async () => {
    setBusy(true);
    setError(null);

    await queue.enqueue({
      __label: `${lead.name} — ${mode}`,
      lead_id: lead.id,
      type: 'Meeting',
      direction: 'outbound',
      /* The API names this `disposition` and aliases it to `code` internally.
         Sending `code` is silently ignored and comes back as "a Meeting
         activity needs an outcome", which reads like the form is broken. */
      disposition: code,
      body: notes || null,
      meeting_mode: mode,
      meeting_at: new Date().toISOString(),
      /* Sent only when the server asked for it. A refusal travels as a value
         of its own rather than as an absent field, which is what lets the
         server tell "would not" from "could not". */
      ...(wantsLocation ? { geo: geo ?? { status: 'unavailable' } } : {}),
    });

    const result = await queue.flush();

    if (result.rejected > 0) {
      /* The server refused it. It stays on the queue as rejected so it is not
         lost, but the person has to see why rather than wonder where it went. */
      const [bad] = await queue.rejected();
      setError(bad?.last_error || 'The server refused this meeting.');
      setBusy(false);
      return;
    }

    onDone(result.sent > 0 ? 'saved' : 'queued');
  };

  if (!meta) {
    return (
      <View style={[s.screen, { justifyContent: 'center' }]}>
        {error
          ? <View style={[s.error, { margin: 16 }]}><Text style={s.errorText}>{error}</Text></View>
          : <ActivityIndicator color={t.accent} />}
      </View>
    );
  }

  const groups = meta.dispositions?.Meeting ?? [];

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <TouchableOpacity onPress={onCancel}><Text style={s.muted}>‹ Back</Text></TouchableOpacity>

      <Text style={[s.h1, { marginTop: 12 }]}>Log a meeting</Text>
      <Text style={[s.muted, { marginBottom: 20 }]}>{lead.name}</Text>

      {error && <View style={s.error}><Text style={s.errorText}>{error}</Text></View>}

      <Text style={s.label}>How did you meet</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {meta.meeting_modes.map((m) => (
          <TouchableOpacity
            key={m}
            onPress={() => setMode(m)}
            style={[s.ghost, {
              paddingHorizontal: 14,
              backgroundColor: mode === m ? t.accent : t.surface,
              borderColor: mode === m ? t.accent : t.border,
            }]}
          >
            <Text style={[s.ghostText, mode === m && { color: t.accentText }]}>{m}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={s.label}>Outcome</Text>
      {groups.map((g) => (
        <View key={g.outcome} style={{ marginBottom: 12 }}>
          <Text style={[s.muted, { marginBottom: 6 }]}>{g.outcome}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {g.options.map((o) => (
              <TouchableOpacity
                key={o.code}
                onPress={() => setCode(o.code)}
                style={[s.ghost, {
                  paddingHorizontal: 14,
                  backgroundColor: code === o.code ? t.accent : t.surface,
                  borderColor: code === o.code ? t.accent : t.border,
                }]}
              >
                <Text style={[s.ghostText, code === o.code && { color: t.accentText }]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}

      <Text style={[s.label, { marginTop: 8 }]}>Notes</Text>
      <TextInput
        style={[s.input, { height: 100, textAlignVertical: 'top', marginBottom: 20 }]}
        value={notes}
        onChangeText={setNotes}
        multiline
        placeholder="What was discussed, and what happens next"
        placeholderTextColor={t.muted}
      />

      {wantsLocation && (
        <View style={{ marginBottom: 20 }}>
          <Text style={s.label}>Where</Text>
          {/* The server's wording, not ours. Notice is a DPDP requirement and
              one wording everywhere is the point of serving it from the API. */}
          <View style={s.notice}>
            {/* All four, not a summary. The server returns purpose, retention,
                visibility and optional because those are the four things a
                person is owed before a position is taken, and its own test
                asserts all four are present. Showing one would defeat that. */}
            {['purpose', 'optional', 'retention', 'visibility']
              .map((k) => meta.geolocation.notice?.[k])
              .filter(Boolean)
              .map((line) => (
                <Text key={line} style={[s.muted, { marginBottom: 6 }]}>{line}</Text>
              ))}
          </View>
          <TouchableOpacity style={s.ghost} onPress={getLocation} disabled={locating}>
            {locating
              ? <ActivityIndicator color={t.text} />
              : <Text style={s.ghostText}>{geo ? 'Capture again' : 'Capture location'}</Text>}
          </TouchableOpacity>
          <Text style={[s.muted, { marginTop: 8 }]}>{describe(geo)}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[s.button, (!code || busy) && { opacity: 0.5 }]}
        onPress={submit}
        disabled={!code || busy}
      >
        {busy ? <ActivityIndicator color={t.accentText} /> : <Text style={s.buttonText}>Save meeting</Text>}
      </TouchableOpacity>
      {!code && <Text style={[s.muted, { marginTop: 8, textAlign: 'center' }]}>Pick an outcome to save.</Text>}
    </ScrollView>
  );
}

import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as queue from './queue.js';
import { t } from './theme.js';

/**
 * What has not reached the server yet.
 *
 * A queue nobody can see is a queue nobody trusts. A rep who logged four
 * meetings in a basement needs to know they are still there, and needs to find
 * out about the one the server refused without discovering it a week later in a
 * report.
 */
export default function PendingBar({ online }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => setItems(await queue.list());

  useEffect(() => {
    refresh();
    return queue.onChange(setItems);
  }, []);

  const waiting = items.filter((i) => i.state === 'queued');
  const bad = items.filter((i) => i.state === 'rejected');
  if (!waiting.length && !bad.length) return null;

  const retry = async () => {
    setBusy(true);
    for (const i of bad) await queue.requeue(i.id);
    await queue.flush();
    setBusy(false);
  };

  return (
    <View style={{
      backgroundColor: bad.length ? '#3a1d1d' : t.surfaceHi,
      borderBottomColor: bad.length ? t.danger : t.border,
      borderBottomWidth: 1,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    }}
    >
      <View style={{ flex: 1 }}>
        {waiting.length > 0 && (
          <Text style={{ color: t.text, fontSize: 13 }}>
            {waiting.length} {waiting.length === 1 ? 'meeting' : 'meetings'} waiting to send
            {online ? '' : ' · no signal'}
          </Text>
        )}
        {bad.length > 0 && (
          <Text style={{ color: '#ffd9d6', fontSize: 13 }}>
            {bad.length} refused — {bad[0].last_error}
          </Text>
        )}
      </View>

      {(bad.length > 0 || (waiting.length > 0 && online)) && (
        <TouchableOpacity onPress={retry} disabled={busy}>
          {busy
            ? <ActivityIndicator color={t.text} />
            : <Text style={{ color: t.accent, fontWeight: '700', fontSize: 13 }}>Retry</Text>}
        </TouchableOpacity>
      )}
    </View>
  );
}

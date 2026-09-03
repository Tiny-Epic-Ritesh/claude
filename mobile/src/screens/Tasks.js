import { useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { api } from '../api.js';
import * as queue from '../queue.js';
import { s, t } from '../theme.js';

/** "in 3h", "2d late" — a rep needs the gap, not a timestamp. */
function when(due) {
  if (!due) return { text: 'No due date', late: false };
  const ms = new Date(`${due.replace(' ', 'T')}Z`).getTime() - Date.now();
  const late = ms < 0;
  const mins = Math.round(Math.abs(ms) / 60000);
  const size = mins < 60 ? `${mins}m`
    : mins < 1440 ? `${Math.round(mins / 60)}h`
      : `${Math.round(mins / 1440)}d`;
  return { text: late ? `${size} late` : `in ${size}`, late };
}

const PRIORITY_COLOUR = {
  Critical: t.danger, High: t.danger, Medium: t.warn, Normal: t.muted, Low: t.muted,
};

export default function Tasks() {
  const [tasks, setTasks] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [doing, setDoing] = useState(null);

  const load = async () => {
    setError(null);
    try {
      /* Already scoped: the list is the caller's own tasks unless they hold
         report.team, and a task on a lead follows that lead's book. */
      const [rows, counts] = await Promise.all([
        api.get('/tasks?limit=100'),
        api.get('/tasks/summary').catch(() => null),
      ]);
      setTasks(rows);
      setSummary(counts);
    } catch (err) {
      setError(err.message);
      setTasks([]);
    }
  };

  useEffect(() => { load(); }, []);

  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  /**
   * Mark a task done.
   *
   * Queued like everything else, so it works in a basement -- and it needs no
   * idempotency key, because setting a status to Done twice lands in the same
   * place. The row is hidden immediately rather than after the round trip: a rep
   * who taps Done and watches the task sit there taps it again.
   */
  const complete = async (task) => {
    setDoing(task.id);
    setTasks((rows) => rows.filter((r) => r.id !== task.id));
    setSummary((c) => (c ? { ...c, open: Math.max(0, c.open - 1), done: c.done + 1 } : c));

    await queue.enqueue({
      path: `/tasks/${task.id}`,
      method: 'PATCH',
      label: `Done · ${task.title}`,
      ref: false,
      // 'Completed' also exists in the data and is the legacy value Setup flags.
      body: { status: 'Done' },
    });
    await queue.flush();
    setDoing(null);
  };

  if (tasks === null) {
    return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={t.accent} /></View>;
  }

  const open = tasks.filter((task) => task.status === 'Open');

  return (
    <View style={s.screen}>
      <View style={s.pad}>
        <Text style={s.h1}>My tasks</Text>
        {summary && (
          <Text style={s.muted}>
            {summary.open} open
            {summary.overdue > 0 && <Text style={{ color: t.danger }}> · {summary.overdue} overdue</Text>}
            {' · '}{summary.done} done
          </Text>
        )}
      </View>

      {error && <View style={[s.error, { marginHorizontal: 16 }]}><Text style={s.errorText}>{error}</Text></View>}

      <FlatList
        data={open}
        keyExtractor={(task) => String(task.id)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} />}
        ListEmptyComponent={<Text style={s.muted}>Nothing open. Pull to refresh.</Text>}
        renderItem={({ item }) => {
          const due = when(item.due_at);
          return (
            <View style={[s.card, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
              <View style={{ flex: 1 }}>
                <Text style={s.h2}>{item.title}</Text>
                <Text style={[s.muted, { marginTop: 4 }]}>
                  {item.lead_name ? `${item.lead_name} · ` : ''}
                  <Text style={{ color: due.late ? t.danger : t.muted }}>{due.text}</Text>
                  {item.priority ? ' · ' : ''}
                  <Text style={{ color: PRIORITY_COLOUR[item.priority] || t.muted }}>{item.priority || ''}</Text>
                </Text>
              </View>
              <TouchableOpacity
                style={[s.ghost, { paddingHorizontal: 14 }]}
                onPress={() => complete(item)}
                disabled={doing === item.id}
              >
                {doing === item.id
                  ? <ActivityIndicator color={t.text} />
                  : <Text style={s.ghostText}>Done</Text>}
              </TouchableOpacity>
            </View>
          );
        }}
      />
    </View>
  );
}

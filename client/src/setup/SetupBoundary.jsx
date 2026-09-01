/**
 * One broken screen must not take Setup with it.
 *
 * This is not hypothetical. `TabVisibility` rendered `<PendingBar draft={draft}>`
 * from inside a nested component where `draft` was not in scope, so opening
 * Navigation threw a ReferenceError — and because nothing caught it, React
 * unmounted the whole tree. The sidebar vanished, the header vanished, and the
 * page went white. An administrator could not even navigate away from the
 * screen that was broken.
 *
 * The bug is fixed. The reason this exists is that the next one will be
 * somewhere else, and the difference between "the SLA screen is broken" and
 * "Setup is broken" is the difference between a bug report and an outage.
 *
 * Deliberately a class component: an error boundary is the one thing hooks
 * still cannot express.
 */

import { Component } from 'react';
import { Icon } from '../components/ui.jsx';

export default class SetupBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Left in the console on purpose. Whoever is looking at the blank panel is
    // usually the person who can fix it, and the stack is what they need.
    console.error('[setup] screen crashed:', error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    // Moving to another screen clears the error, so a crash is not sticky —
    // otherwise the panel stays broken until a full reload even after you
    // navigate away.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="setup-crash">
        <Icon name="warning" size={22} />
        <div>
          <h2>This screen could not be drawn</h2>
          <p className="muted">
            Everything else in Setup still works — pick another screen from the sidebar.
            Nothing was saved or changed by this.
          </p>
          {/* The message, not a friendly paraphrase. The person reading it is an
              administrator, and "something went wrong" tells them nothing they
              can pass on. */}
          <pre>{String(error?.message ?? error)}</pre>
        </div>
      </div>
    );
  }
}

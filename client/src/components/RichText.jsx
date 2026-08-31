/**
 * The formatting editor for client email (P2-09).
 *
 * Hand-built on contenteditable rather than pulled from npm. Two reasons: this
 * app has three runtime dependencies and an editor would be the first piece of
 * UI we did not control, and it runs in a session holding client PII, where a
 * compromised package is the worst kind to have. The trade is that the toolbar
 * is deliberately small — the formatting an RM actually uses writing to a
 * client, and nothing else.
 *
 * WHY execCommand, WHICH IS DEPRECATED
 *
 * It is deprecated and it is still the only thing every browser implements for
 * this. The alternative is hand-managing Selection and Range across every
 * browser's idea of where a caret sits inside a partially-selected list item,
 * which is a large amount of subtle code to get wrong. Deprecated here means
 * "no longer specified", not "removed": no engine has signalled removal, and
 * the blast radius if one ever does is that bold stops working in one dialog.
 *
 * NOTHING HERE IS A SECURITY CONTROL. A person can paste arbitrary markup into
 * any contenteditable, and this component makes no attempt to stop them. The
 * body is sanitised on the server in engine/sanitize.js, which is the only
 * place it can be done to any effect — the browser is not the only thing that
 * can post to the send route.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

/* Faces that exist on the machines this is read on, with a real fallback. */
const FONTS = [
  { label: 'Default', value: '' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
];

/* Points, not the 1–7 scale execCommand uses, because a person choosing a font
   size is thinking in points and the mapping is ours to do. */
const SIZES = [
  { label: '10', cmd: '2' },
  { label: '12', cmd: '3' },
  { label: '14', cmd: '4' },
  { label: '18', cmd: '5' },
  { label: '24', cmd: '6' },
];

export default function RichText({ value, onChange, placeholder, rows = 10, id }) {
  const ref = useRef(null);
  const [active, setActive] = useState({});

  /* Write the incoming value in only when it differs from what is on screen.
   * Assigning innerHTML on every render would move the caret to the start on
   * each keystroke, which is the classic way to make a contenteditable
   * unusable. */
  useEffect(() => {
    const el = ref.current;
    if (el && value !== el.innerHTML) el.innerHTML = value || '';
  }, [value]);

  /** Which buttons should look pressed, for wherever the caret is now. */
  const refreshActive = () => {
    if (!document.queryCommandState) return;
    const state = {};
    for (const c of ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList']) {
      try { state[c] = document.queryCommandState(c); } catch { state[c] = false; }
    }
    setActive(state);
  };

  const exec = (command, arg) => {
    ref.current?.focus();
    // eslint-disable-next-line no-restricted-syntax
    document.execCommand(command, false, arg);
    onChange(ref.current.innerHTML);
    refreshActive();
  };

  const addLink = () => {
    const url = window.prompt('Link to where?', 'https://');
    if (!url) return;
    // Refused here as well as on the server. The server is what makes it safe;
    // this is so the RM finds out now rather than on send.
    if (!/^(https?:|mailto:|tel:)/i.test(url.trim())) {
      window.alert('Links must start with https://, mailto: or tel:');
      return;
    }
    exec('createLink', url.trim());
  };

  const Btn = ({ cmd, icon, title, arg }) => (
    <button
      type="button"
      className={`rt-btn ${active[cmd] ? 'is-on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={Boolean(active[cmd])}
      // onMouseDown, not onClick: clicking a button blurs the editor and the
      // selection is gone before the handler runs.
      onMouseDown={(e) => { e.preventDefault(); exec(cmd, arg); }}
    >
      <Icon name={icon} size={16} />
    </button>
  );

  return (
    <div className="rt">
      <div className="rt-toolbar" role="toolbar" aria-label="Formatting">
        <Btn cmd="bold" icon="format_bold" title="Bold" />
        <Btn cmd="italic" icon="format_italic" title="Italic" />
        <Btn cmd="underline" icon="format_underlined" title="Underline" />

        <span className="rt-sep" />

        <Btn cmd="insertUnorderedList" icon="format_list_bulleted" title="Bulleted list" />
        <Btn cmd="insertOrderedList" icon="format_list_numbered" title="Numbered list" />

        <span className="rt-sep" />

        <button type="button" className="rt-btn" title="Add link" aria-label="Add link"
          onMouseDown={(e) => { e.preventDefault(); addLink(); }}>
          <Icon name="link" size={16} />
        </button>

        <span className="rt-sep" />

        <select
          className="rt-select"
          aria-label="Font"
          defaultValue=""
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { if (e.target.value) exec('fontName', e.target.value); }}
        >
          {FONTS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>

        <select
          className="rt-select rt-size"
          aria-label="Font size"
          defaultValue=""
          onChange={(e) => { if (e.target.value) exec('fontSize', e.target.value); }}
        >
          <option value="">Size</option>
          {SIZES.map((s) => <option key={s.label} value={s.cmd}>{s.label}</option>)}
        </select>

        <span className="rt-spacer" />

        <button
          type="button"
          className="rt-btn"
          title="Clear formatting"
          aria-label="Clear formatting"
          onMouseDown={(e) => { e.preventDefault(); exec('removeFormat'); }}
        >
          <Icon name="format_clear" size={16} />
        </button>
      </div>

      <div
        id={id}
        ref={ref}
        className="rt-body"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        data-placeholder={placeholder}
        style={{ minHeight: `${rows * 1.6}em` }}
        onInput={() => onChange(ref.current.innerHTML)}
        onKeyUp={refreshActive}
        onMouseUp={refreshActive}
        onFocus={refreshActive}
        /* Paste as plain text. Anything else arrives carrying the source page's
           markup and styles, which the server then strips on send — so the RM
           would compose against a preview that is not what the client receives.
           Better that the paste looks the same in both places. */
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          // eslint-disable-next-line no-restricted-syntax
          document.execCommand('insertText', false, text);
          onChange(ref.current.innerHTML);
        }}
      />
    </div>
  );
}

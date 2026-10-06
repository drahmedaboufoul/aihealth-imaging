// Viewer-wide shortcuts must not also handle keys owned by a focused control.
const INTERACTIVE = 'input,textarea,select,button,a[href],[role="slider"],[role="combobox"],[role="listbox"],[role="option"],[role="menuitem"],[role="tab"],[role="spinbutton"],[contenteditable]:not([contenteditable="false"])';

export function shouldIgnoreViewerHotkey(event) {
  return Boolean(event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey
    || event.target?.isContentEditable || event.target?.closest?.(INTERACTIVE));
}

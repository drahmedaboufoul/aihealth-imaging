import { describe, expect, it } from 'vitest';
import { shouldIgnoreViewerHotkey } from '../src/lib/viewerKeyboard';

describe('viewer hotkey ownership', () => {
  it.each(['defaultPrevented', 'isComposing', 'metaKey', 'ctrlKey', 'altKey'])('does not intercept %s events', key => {
    expect(shouldIgnoreViewerHotkey({ [key]: true })).toBe(true);
  });
  it('respects editable descendants and delegated interactive controls', () => {
    expect(shouldIgnoreViewerHotkey({ target: { isContentEditable: true } })).toBe(true);
    expect(shouldIgnoreViewerHotkey({ target: { closest: () => ({ role: 'slider' }) } })).toBe(true);
  });
  it('keeps unhandled canvas shortcuts available', () => {
    expect(shouldIgnoreViewerHotkey({ target: { closest: () => null } })).toBe(false);
  });
});

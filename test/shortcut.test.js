import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWallpaperShortcut, buildWallpaperShortcutObject } from '../src/shortcut.js';

const URL = 'https://horror.example.com/api/wallpaper/today.jpg';

test('shortcut object chains Get Contents of URL into Set Wallpaper', () => {
  const obj = buildWallpaperShortcutObject(URL);
  const actions = obj.WFWorkflowActions;
  assert.equal(actions.length, 2);

  const [download, setWallpaper] = actions;
  assert.equal(download.WFWorkflowActionIdentifier, 'is.workflow.actions.downloadurl');
  assert.equal(download.WFWorkflowActionParameters.WFURL, URL);

  assert.equal(setWallpaper.WFWorkflowActionIdentifier, 'is.workflow.actions.wallpaper.set');

  // The Set Wallpaper input must reference the download action's output UUID,
  // otherwise the two actions aren't wired together.
  const inputRef = setWallpaper.WFWorkflowActionParameters.WFInput.Value;
  assert.equal(inputRef.Type, 'ActionOutput');
  assert.equal(inputRef.OutputUUID, download.WFWorkflowActionParameters.UUID);
});

test('buildWallpaperShortcut emits a well-formed XML plist containing the URL', () => {
  const xml = buildWallpaperShortcut(URL);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist PUBLIC/);
  assert.match(xml, /<plist version="1\.0">/);
  assert.ok(xml.trim().endsWith('</plist>'));
  assert.ok(xml.includes('<key>WFWorkflowActions</key>'));
  assert.ok(xml.includes(URL));
  assert.ok(xml.includes('is.workflow.actions.downloadurl'));
  assert.ok(xml.includes('is.workflow.actions.wallpaper.set'));

  // Booleans must serialize as plist <false/>, not the string "false".
  assert.ok(xml.includes('<false/>'));
  assert.ok(!/<string>false<\/string>/.test(xml));

  // Balanced <dict>/<array> tags — a cheap structural sanity check.
  const count = (re) => (xml.match(re) || []).length;
  assert.equal(count(/<dict>/g) + count(/<dict\/>/g), count(/<\/dict>/g) + count(/<dict\/>/g));
  assert.equal(count(/<array>/g) + count(/<array\/>/g), count(/<\/array>/g) + count(/<array\/>/g));
});

test('special characters in the URL are XML-escaped', () => {
  const xml = buildWallpaperShortcut('https://ex.com/w?a=1&b=2');
  assert.ok(xml.includes('a=1&amp;b=2'));
  assert.ok(!xml.includes('a=1&b=2'));
});

test('rejects a non-absolute URL', () => {
  assert.throws(() => buildWallpaperShortcut('/relative/path'), /absolute http/);
  assert.throws(() => buildWallpaperShortcutObject(''), /absolute http/);
});

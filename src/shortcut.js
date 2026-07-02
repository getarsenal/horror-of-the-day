// Generates an unsigned Apple Shortcuts (`.shortcut`) file that:
//   1. Gets the contents of today's wallpaper URL, then
//   2. Sets the downloaded image as the Home & Lock screen wallpaper.
//
// A `.shortcut` file is a plist. Apple's App Store-distributed shortcuts are
// signed by a private Apple service we can't call, but iOS/iPadOS will import
// an *unsigned* shortcut when the user enables
//   Settings → Shortcuts → Allow Untrusted Shortcuts
// (that toggle only appears after running any one shortcut once). This is the
// same plain-plist format the Shortcuts app itself writes on "Export Unsigned".
//
// We emit an XML plist (no dependencies) rather than a binary plist so the
// output is human-inspectable and easy to diff.

// Stable UUIDs linking the "Get Contents of URL" output to the "Set Wallpaper"
// input. They only need to be internally consistent within one file, not
// globally unique across imports, so fixed constants are fine and keep the
// output deterministic (and therefore testable).
const URL_ACTION_UUID = 'A1B2C3D4-0001-4A1A-9E01-HORROROFDAY01';
const OUTPUT_NAME = 'Horror of the Day';

// Standard content-item classes the Shortcuts app writes for a shortcut that
// accepts input; copied verbatim so the file matches what iOS expects.
const INPUT_CONTENT_ITEM_CLASSES = [
  'WFAppStoreAppContentItem',
  'WFArticleContentItem',
  'WFContactContentItem',
  'WFDateContentItem',
  'WFEmailAddressContentItem',
  'WFFolderContentItem',
  'WFGenericFileContentItem',
  'WFImageContentItem',
  'WFiTunesProductContentItem',
  'WFLocationContentItem',
  'WFDCMapsLinkContentItem',
  'WFAVAssetContentItem',
  'WFPDFContentItem',
  'WFPhoneNumberContentItem',
  'WFRichTextContentItem',
  'WFSafariWebPageContentItem',
  'WFStringContentItem',
  'WFURLContentItem',
];

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Serialize a JS value into an XML-plist fragment. Handles the subset of
// plist types a shortcut needs: dict, array, string, integer, real, bool.
function toPlist(value, indent = 0) {
  const pad = '\t'.repeat(indent);
  const padIn = '\t'.repeat(indent + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>`;
    const items = value.map((v) => toPlist(v, indent + 1)).join('\n');
    return `${pad}<array>\n${items}\n${pad}</array>`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}<dict/>`;
    const body = keys
      .map((k) => `${padIn}<key>${xmlEscape(k)}</key>\n${toPlist(value[k], indent + 1)}`)
      .join('\n');
    return `${pad}<dict>\n${body}\n${pad}</dict>`;
  }

  if (typeof value === 'boolean') return `${pad}<${value ? 'true' : 'false'}/>`;

  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`;
  }

  return `${pad}<string>${xmlEscape(value)}</string>`;
}

// Build the shortcut definition object for a given wallpaper URL.
export function buildWallpaperShortcutObject(wallpaperUrl) {
  if (!wallpaperUrl || !/^https?:\/\//i.test(wallpaperUrl)) {
    throw new Error('wallpaperUrl must be an absolute http(s) URL');
  }
  return {
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: {
      WFWorkflowIconStartColor: 4292093695, // a bright red
      WFWorkflowIconGlyphNumber: 59767, // a ghost-ish glyph
    },
    WFWorkflowImportQuestions: [],
    WFWorkflowTypes: ['WatchKit'],
    WFWorkflowInputContentItemClasses: INPUT_CONTENT_ITEM_CLASSES,
    WFWorkflowActions: [
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
        WFWorkflowActionParameters: {
          WFURL: wallpaperUrl,
          UUID: URL_ACTION_UUID,
          CustomOutputName: OUTPUT_NAME,
        },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.wallpaper.set',
        WFWorkflowActionParameters: {
          WFWallpaperShowsPreview: false,
          WFInput: {
            WFSerializationType: 'WFTextTokenAttachment',
            Value: {
              Type: 'ActionOutput',
              OutputUUID: URL_ACTION_UUID,
              OutputName: OUTPUT_NAME,
            },
          },
        },
      },
    ],
  };
}

// Build the full `.shortcut` file contents (XML plist) as a string.
export function buildWallpaperShortcut(wallpaperUrl) {
  const obj = buildWallpaperShortcutObject(wallpaperUrl);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    toPlist(obj, 0) +
    '\n</plist>\n'
  );
}

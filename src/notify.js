// Push notifications via ntfy.sh (https://ntfy.sh). When CH_NTFY_TOPIC is set,
// a new public submission POSTs a push to that topic — subscribe to it in the
// ntfy phone app to get pinged, with a tap-through to the moderation console.
//
// ntfy topics are public to anyone who knows the name, so use a long random
// topic (it doubles as the shared secret). Self-hosted ntfy works too via
// CH_NTFY_SERVER.

export function ntfyConfig(env = process.env) {
  const topic = env.CH_NTFY_TOPIC;
  if (!topic) return null;
  const server = (env.CH_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  return { url: `${server}/${encodeURIComponent(topic)}` };
}

// Low-level push. ntfy control headers must be ASCII (Title, Click, Attach),
// while the message body may be UTF-8 — so anything possibly non-ASCII (image
// titles, emoji) goes in the body, not a header.
export async function sendPush(
  { title = 'Horror of the Day', body = '', click, attach, tags = 'eyes', priority = 'default' } = {},
  { fetchImpl = fetch, config = ntfyConfig() } = {}
) {
  if (!config) return { sent: false, reason: 'ntfy not configured' };
  const headers = { Title: title, Tags: tags, Priority: priority };
  if (click) headers.Click = click;   // tap the push → open this URL
  if (attach) headers.Attach = attach; // show this image in the notification
  try {
    const res = await fetchImpl(config.url, { method: 'POST', headers, body });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

export async function notifySubmission({ title, imageUrl, adminUrl } = {}, opts = {}) {
  return sendPush(
    {
      title: 'New Horror submission',
      body: `"${title ?? 'Untitled'}" is awaiting review`,
      click: adminUrl,
      attach: imageUrl,
    },
    opts
  );
}

// Fire-and-forget helper: never throws, never blocks the caller's response.
export function notifySubmissionAsync(args, opts) {
  Promise.resolve()
    .then(() => notifySubmission(args, opts))
    .catch(() => {});
}

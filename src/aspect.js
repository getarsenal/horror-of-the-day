// Phone wallpapers are tall and narrow, so a landscape image gets cropped down
// to an ugly center strip. We consider an image "phone-friendly" when it's
// portrait or square — i.e. its width/height ratio is at or below a threshold
// (default 1.0). Tune with CH_MAX_ASPECT (e.g. 1.1 to allow slightly-wide).

export const DEFAULT_MAX_ASPECT = 1.0;

export function maxAspect() {
  const v = Number(process.env.CH_MAX_ASPECT);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_ASPECT;
}

// Unknown dimensions (null) are treated as NOT phone-friendly, so images with
// known portrait dimensions are preferred over ones we haven't measured yet.
export function isPhoneFriendly(width, height, max = maxAspect()) {
  if (!width || !height) return false;
  return width / height <= max;
}

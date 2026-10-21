/** Device capability, never a layout breakpoint or an authorization identity. */
export function isMobileNotificationClient(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (/Android|iPhone|iPad|iPod/iu.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
  );
}

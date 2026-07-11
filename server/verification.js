const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstileToken({
  secretKey,
  token,
  ip,
  fetchImpl = fetch,
}) {
  if (!secretKey) {
    return { enabled: false, success: true };
  }

  if (!token) {
    return { enabled: true, success: false, error: "Missing verification token." };
  }

  const body = new URLSearchParams({
    secret: secretKey,
    response: token,
  });

  if (ip) {
    body.set("remoteip", ip);
  }

  const response = await fetchImpl(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    return { enabled: true, success: false, error: "Verification service failed." };
  }

  const payload = await response.json();

  if (!payload.success) {
    return { enabled: true, success: false, error: "Verification was rejected." };
  }

  return { enabled: true, success: true };
}

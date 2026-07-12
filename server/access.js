export function isAuthEnabled(config) {
  return Boolean(
    config.sessionSecret &&
      config.githubClientId &&
      config.githubClientSecret &&
      config.githubCallbackUrl,
  );
}

export function isAdminEmail(email, adminEmails = []) {
  if (!email) {
    return false;
  }

  return adminEmails.includes(email.toLowerCase());
}

export function buildSessionSnapshot({
  authEnabled,
  user,
  acceptedPolicyVersion,
  policyVersion,
  adminEmails = [],
  moderationActive = false,
}) {
  return {
    authEnabled,
    signedIn: Boolean(user),
    userStatus: user?.status ?? null,
    policyAccepted: acceptedPolicyVersion === policyVersion,
    acceptableUseVersion: policyVersion,
    isAdmin: isAdminEmail(user?.email, adminEmails),
    moderationActive,
    user: user
      ? {
          id: user.id,
          login: user.login,
          displayName: user.displayName,
          email: user.email,
          status: user.status,
        }
      : null,
  };
}

export function assertProcessingAccess({ authEnabled, user, acceptedPolicyVersion, policyVersion }) {
  if (!authEnabled) {
    return;
  }

  if (!user) {
    throw new Error("Sign in with a verified GitHub email before processing images.");
  }

  if (user.status === "blocked") {
    throw new Error("Your account is blocked from processing images.");
  }

  if (user.status === "review_required") {
    throw new Error("Your account requires manual review before processing can continue.");
  }

  if (acceptedPolicyVersion !== policyVersion) {
    throw new Error("Accept the usage policy before processing images.");
  }
}

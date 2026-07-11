export function isAuthEnabled(config) {
  return Boolean(
    config.sessionSecret &&
      config.githubClientId &&
      config.githubClientSecret &&
      config.githubCallbackUrl,
  );
}

export function buildSessionSnapshot({ authEnabled, user, acceptedPolicyVersion, policyVersion }) {
  return {
    authEnabled,
    signedIn: Boolean(user),
    policyAccepted: acceptedPolicyVersion === policyVersion,
    acceptableUseVersion: policyVersion,
    user: user
      ? {
          login: user.login,
          displayName: user.displayName,
          email: user.email,
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

  if (acceptedPolicyVersion !== policyVersion) {
    throw new Error("Accept the usage policy before processing images.");
  }
}

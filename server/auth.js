import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";

export function configurePassport({
  githubClientId,
  githubClientSecret,
  githubCallbackUrl,
  dataStore,
}) {
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user, done) => {
    done(null, user ?? null);
  });

  passport.use(
    new GitHubStrategy(
      {
        clientID: githubClientId,
        clientSecret: githubClientSecret,
        callbackURL: githubCallbackUrl,
        scope: ["user:email"],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        const verifiedEmail = profile.emails?.find((email) => email.verified)?.value;

        if (!verifiedEmail) {
          done(null, false, {
            message: "A verified GitHub email is required to use this tool.",
          });
          return;
        }

        try {
          const user = await dataStore.findOrCreateUser({
            githubId: profile.id,
            login: profile.username,
            displayName: profile.displayName || profile.username,
            email: verifiedEmail,
          });

          done(null, user);
        } catch (error) {
          done(error);
        }
      },
    ),
  );

  return passport;
}

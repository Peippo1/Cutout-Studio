import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";

export function configurePassport({ githubClientId, githubClientSecret, githubCallbackUrl }) {
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
      (_accessToken, _refreshToken, profile, done) => {
        const verifiedEmail = profile.emails?.find((email) => email.verified)?.value;

        if (!verifiedEmail) {
          done(null, false, {
            message: "A verified GitHub email is required to use this tool.",
          });
          return;
        }

        done(null, {
          id: profile.id,
          login: profile.username,
          displayName: profile.displayName || profile.username,
          email: verifiedEmail,
        });
      },
    ),
  );

  return passport;
}

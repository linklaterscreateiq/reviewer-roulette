# Publishing a new version

Publishing is done by GitHub Actions, from a published GitHub Release.

1. Raise a pull request bumping `version` in `package.json`, and merge it once
   Build is green.
2. Draft a new release at
   <https://github.com/linklaterscreateiq/reviewer-roulette/releases/new>,
   creating a tag that names the new version (`1.0.8`, matching the existing
   tags) against `main`, and publish it.
3. The `Publish` workflow type-checks, runs the smoke test against the bundle it
   is about to upload, and publishes it. It refuses to publish if the tag does
   not name the version in `package.json`.

No npm token is stored in this repository. The workflow authenticates with npm
over OIDC, which requires `.github/workflows/publish-npm.yml` to be registered
as the package's trusted publisher in its settings on npmjs.com. A side effect
is that published versions carry a provenance attestation linking them to the
commit and workflow run that built them.

`npm run upload` still publishes from a developer machine with npm credentials.
It skips every check above and produces a release with no provenance, so use it
only if the workflow itself is broken.

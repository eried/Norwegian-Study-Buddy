# Episode player tests

Headless Chromium tests for the «No entendí» card, review flow, marking, and the top bar.

```bash
cd tests
npm install
npm test
```

Requires Chromium/Chrome. Set `CHROME` if it is not at `/usr/bin/google-chrome`.

The Ya entiendo sync test talks to the notes Worker with the saved passphrase (default `123`) and deletes any notes it created.

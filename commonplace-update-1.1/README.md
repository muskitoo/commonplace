# Commonplace

Your commonplace book: capture quotes, thoughts and takeaways, reflect on one card a day, and gather cards into folders around an idea. It syncs live between your iPad, iPhone and Mac through your own free Firebase project, and works offline.

Setup takes about 20 minutes, once. You need your Google account (for Firebase) and a free GitHub account.

---

## Part 1 · Create your Firebase project (about 10 minutes)

Do this on your Mac.

1. **Create the project.** Go to [console.firebase.google.com](https://console.firebase.google.com), sign in with your Google account and create a new project called `commonplace`. You can switch Google Analytics off; the app doesn't use it.

2. **Switch on email sign-in.** In the left menu open **Authentication** (it may sit under *Build* or *Security*). Click **Get started**, open the **Sign-in method** tab, choose **Email/Password**, switch on the first toggle (leave "Email link" off) and click **Save**.

3. **Create the database.** In the left menu open **Firestore Database** and click **Create database**.
   - If asked for an edition, choose **Standard**.
   - Leave the database ID as `(default)`.
   - For location choose **europe-west2 (London)**. This can't be changed later.
   - Choose **Start in production mode** and click **Create**.

4. **Set the rules.** Still in Firestore Database, open the **Rules** tab, delete what's there, paste in everything from the `firestore.rules` file in this folder, and click **Publish**. This makes sure only you can read and write your cards.

5. **Register the web app and copy its settings.** Click the gear icon next to *Project Overview* → **Project settings**. Under **Your apps**, click the web icon `</>`. Give it the nickname `Commonplace`, leave "Firebase Hosting" unticked, and click **Register app**. You'll see a block of code containing `const firebaseConfig = { … }`. Keep this page open for Part 2.

## Part 2 · Put the app on GitHub Pages (about 10 minutes)

1. **Paste your settings.** Open `firebase-config.js` from this folder in TextEdit and replace the placeholder values with the ones from your `firebaseConfig` (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId). Keep the quote marks and commas. Save.
   > These values identify your project; they aren't secret passwords. The rules from Part 1 are what protect your cards.

2. **Create the repository.** Sign in at [github.com](https://github.com), click **+** → **New repository**, name it `commonplace`, set it to **Public** (free GitHub Pages needs this; your cards are never stored in it), and click **Create repository**.

3. **Upload the files.** On the new repository's page click **uploading an existing file**. In Finder, open this folder, select **everything inside it** (including the `icons`, `vendor` and `source` folders) and drag it onto the page. Wait for the uploads to finish, then click **Commit changes**.
   > If the folders don't upload from Safari, use Chrome for this step.
   > Check that `index.html` sits at the top level of the repository, not inside another folder.

4. **Turn on Pages.** In the repository go to **Settings** → **Pages**. Under *Build and deployment* choose **Deploy from a branch**, pick the **main** branch and the **/ (root)** folder, and click **Save**. After a minute or two your app is live at:
   `https://YOUR-GITHUB-USERNAME.github.io/commonplace/`

## Part 3 · Install it on your devices

1. Open your app's address in **Safari** and choose **New here? Create an account**. Use your email and a password you'll remember. This is your account in *your* Firebase project; nobody else's.
2. **iPad and iPhone:** in Safari tap **Share** → **Add to Home Screen** (make sure *Open as Web App* is on if you see it) → **Add**. Open it from the home screen and sign in once.
3. **Mac:** in Safari choose **File** → **Add to Dock**.

Each device keeps its own copy of your cards, so the app opens instantly and works offline. Anything you add offline syncs as soon as you're back online. The header shows **synced**, **saving…** or **offline · saved on this device**.

## Face ID / Touch ID lock (optional)

On each device, tap **Account** → **Turn lock on** and confirm with Face ID or Touch ID. From then on, opening Commonplace on that device shows a locked screen; tap **Unlock** to open it. You can choose how soon it locks again after you leave the app. If Face ID or Touch ID ever fails, tap **Use password instead**.

The lock uses a passkey saved in your iCloud Keychain. It's a privacy lock for the device: your cards stay protected in Firebase by your account and the database rules either way.

## Part 4 · Bring your cards over from the claude.ai version

1. In the claude.ai version of Commonplace, open **Library** and tap **Copy backup**.
2. In your new app, tap **Account** → **Import cards**, paste into the box and tap **Import**.

Your cards, folders and reflection streak come across. Importing the same backup twice updates cards rather than doubling them.

## Optional · Lock the database to just you

The rules already stop anyone reading your cards, but anyone who finds your app could still create their own account in your Firebase project. To stop that:

1. In the app tap **Account** and copy **Your user ID**.
2. In Firebase → Firestore Database → **Rules**, replace the rules with the version below (paste your ID where shown) and click **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid
                         && uid == "PASTE_YOUR_USER_ID";
    }
  }
}
```

3. If you like, also go to **Authentication** → **Settings** → **User actions** and untick **Enable create (sign-up)**, then **Save**.

## Backups

Your cards live in Firebase and on each device. For extra peace of mind, every so often tap **Account** → **Save a backup file** and save it to iCloud Drive.

## Free limits

Firebase's free plan includes 1 GiB of storage, 50,000 reads and 20,000 writes a day. A personal commonplace book uses a tiny fraction of that, and you never need to add a payment card.

## Updating the app later

When you get new versions of `index.html` or `app.js`, upload them to the repository the same way (they replace the old ones), and change the `VERSION` line at the top of `sw.js` (for example to `commonplace-v1.0.1`) so your devices fetch the update. Close and reopen the app twice to see it.

## What's in this folder

| File | What it is |
| --- | --- |
| `index.html` | The app's page and styles |
| `app.js` | The app, with Firebase built in |
| `firebase-config.js` | **Your** Firebase settings (edit this) |
| `firestore.rules` | Database rules to paste into Firebase |
| `sw.js` | Makes the app work offline |
| `manifest.webmanifest`, `icons/`, `favicon.svg` | Name and icons for the home screen |
| `vendor/jspdf.umd.min.js` | Builds folder PDFs |
| `source/` | Readable source of `app.js`, for future changes |

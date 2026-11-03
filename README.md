# LinkedIn Easy Apply Retriever

A local tool to look up your LinkedIn job application records and saved screening answers for one job, without downloading your full LinkedIn archive.

## Requirements

- Node.js 18 or newer
- A LinkedIn account in the EEA or Switzerland
- A LinkedIn developer app with Member Data Portability (Member) access

## Start the app

```sh
npm start
```

Open the `http://127.0.0.1:<port>` address printed in the terminal.

## LinkedIn setup

The app uses a token you generate manually with LinkedIn's Developer Portal. It does not perform OAuth sign-in itself, so no redirect URL or PKCE setup is required.

1. Follow LinkedIn's [Member Data Portability (Member) guide](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/). This API is available to eligible members in the EEA and Switzerland.
2. In the [Developer Portal](https://www.linkedin.com/developers/apps/new?src=re-other&veh=learn.microsoft.com), create an app using LinkedIn's designated default company page for this product. Do not create a new company page for it.
3. In your app's Products tab, request **Member Data Portability API (Member)** and accept the terms. Continue after the product is provisioned for your app.
4. Open **Docs and tools → OAuth Token Tools**, choose **Create token**, select your provisioned app, and request the `r_dma_portability_self_serve` scope.
5. Sign in to LinkedIn and approve the consent screen. Copy the generated token and paste it into the app.

The token's details page shows its time to live. When LinkedIn rejects an expired token, generate a new one and paste it again.

## Reuse a locally saved token

The app checks the repository root for a conventional `.env` file. It never loads a saved token without asking first. If it finds one, choose **Use saved token** or **Not now**; if it finds multiple, select the one to use. The token values are never displayed in the page.

Prefer `.env` for local secrets. Store one token like this:

```dotenv
LINKEDIN_ACCESS_TOKEN=your_access_token
```

For multiple tokens, use one variable per token and a short label in the variable name:

```dotenv
LINKEDIN_ACCESS_TOKEN_PERSONAL=your_first_access_token
LINKEDIN_ACCESS_TOKEN_WORK=your_second_access_token
```

The `.env` file is ignored by Git. The app does not scan other repository files for strings that look like tokens. A selected token is held in server memory only until you disconnect or stop the app.

## Look up an application

Choose a job ID or LinkedIn job-post URL; no job is preselected. The app queries `JOB_APPLICATIONS` and `TALENT_QUESTION_SAVED_RESPONSE`. Saved answers without a matching job ID are shown separately as unassociated, not as confirmed answers for that job.

## Privacy

The server listens only on your computer's loopback interface. Pasted and selected access tokens stay in server memory and are cleared when you disconnect or stop the server. Search results stay in the current page. Never commit a LinkedIn token, client secret, or personal application data.

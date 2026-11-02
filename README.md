# LinkedIn Easy Apply Retriever

A local tool to look up your LinkedIn job application records and saved screening answers for one job, without downloading your full LinkedIn archive.

## Requirements

- Node.js 18 or newer
- A LinkedIn account in the EEA or Switzerland
- A LinkedIn developer app with Member Data Portability (Member) access

## Start the app

Copy .env.example to .env and set `LINKEDIN_CLIENT_ID` to your app's API Key (Client ID, not a client secret). Then run:

```sh
npm start
```

Open the `http://127.0.0.1:<port>` address printed in the terminal.

## LinkedIn setup

1. Follow LinkedIn's [Member Data Portability (Member) guide](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/). This API is for members in the EEA and Switzerland.
2. In the [Developer Portal](https://www.linkedin.com/developers/apps), create an app using LinkedIn's designated default company page for this product, then request the **Member Data Portability API (Member)** product.
3. Ask your LinkedIn point of contact to enable native PKCE, as described in the [native OAuth guide](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native). Set the Client ID in .env and restart.
4. Choose **Connect with LinkedIn** and approve the `r_dma_portability_self_serve` scope.

If PKCE is not enabled, use LinkedIn's [OAuth Token Tools](https://learn.microsoft.com/en-us/linkedin/shared/authentication/developer-portal-tools) to generate a token with the same scope, then paste it into **Use a token instead**.

## Look up an application

Choose a job ID or LinkedIn job-post URL; no job is preselected. The app queries `JOB_APPLICATIONS` and `TALENT_QUESTION_SAVED_RESPONSE`. Saved answers without a matching job ID are shown separately as unassociated, not as confirmed answers for that job.

## Privacy

The server listens only on your computer's loopback interface. Tokens and temporary OAuth data stay in memory and are cleared when you disconnect or stop the server. Search results stay in the current page. Never commit a LinkedIn token, client secret, or personal application data; .env is ignored by Git.

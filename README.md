# Weblink

## Introduction

Weblink is a browser-based chat application built on WebRTC, requiring no downloads and usable directly in your browser. It offers a serverless, peer-to-peer architecture powered by Firebase signaling and deployed on Vercel. The application supports real-time text chat, file transfer, file storage, video calls, and multi-party communication through a mesh network. Advanced features include chunked and compressed file transfers for efficient and resumable large file sharing, multi-channel data transfer using multiple DataChannels for faster performance, and IndexedDB caching to minimize memory usage during transfers. End-to-end encryption ensures privacy and security with encrypted signaling messages.

This project is deployed on Vercel. [Click here to access](https://web1ink.vercel.app).

For mainland Chinese users, you can use [https://webl.ink](https://webl.ink) which deployed on aliyun instead.

[**中文介绍**](README_CN.md)

![Chat Example 1](screenshots/example_dark_cn.png)

![Chat Example 2](screenshots/example_light_cn.png)

## Usage

### Run Locally

```base
git clone https://github.com/99percentpeople/weblink.git
cd weblink
pnpm install
```

Make sure you configure the Firebase keys in the project (as shown below), then run the following command:

```base
# Development
pnpm dev
# Build
pnpm build
```

### Deploy to Vercel

To deploy this project to Vercel, follow these steps:

1. Go to the Vercel website and log in (or create an account).

2. Connect your GitHub repository and select the cloned repository.

3. In your Vercel project settings, find "Environment Variables" and add the Firebase API key and other environment variables (as shown below).

4. Click the "Deploy" button, and Vercel will automatically build and deploy your project.

### Environment Variables Configuration (Firebase)

You will need to configure Firebase keys for both local development and deployment to Vercel. Add the following Firebase environment variables:

`VITE_FIREBASE_API_KEY`

`VITE_FIREBASE_AUTH_DOMAIN`

`VITE_FIREBASE_PROJECT_ID`

`VITE_FIREBASE_STORAGE_BUCKET`

`VITE_FIREBASE_MESSAGING_SENDER_ID`

`VITE_FIREBASE_APP_ID`

`VITE_FIREBASE_DATABASE_URL`

### Vercel Environment Variables Configuration

For Vercel deployment, set the environment variables by following these steps:

1. Open your Vercel project and go to "Settings."

2. Find "Environment Variables."

3. Add the Firebase configuration items above and input the corresponding values.

### WEBSOCKET Configuration

This application can deploy its own WEBSOCKET server, and a WEBSOCKET server is provided. You can choose to use it or not. For details, please refer to [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server).

### Local Environment Variables (.env.local)

For local development, create a .env.local file and add the Firebase keys:

```env
# backend choose FIREBASE or WEBSOCKET

# FIREBASE
VITE_BACKEND=FIREBASE
VITE_FIREBASE_API_KEY=your-firebase-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-firebase-auth-domain
VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-firebase-storage-bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your-firebase-messaging-sender-id
VITE_FIREBASE_APP_ID=your-firebase-app-id
VITE_FIREBASE_DATABASE_URL=your-database-url

# WEBSOCKET
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=your-websocket-url
```

## Notes

### Configuring TURN Server (Non-LAN Connections)

If you are using P2P connections outside a local area network (in a NAT environment), you may need to configure a TURN server to ensure connections are established. In the settings page, you can configure the TURN server with the following format:

**TURN Configuration Format:**

```
turn:turn1.example.com:3478|user1|pass1|longterm
turns:turn2.example.com:5349|user2|pass2|hmac
```

## Contribution

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is open-sourced under the [MIT License](LICENSE).

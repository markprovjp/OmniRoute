# VPS Deployment and Quota Management Guide

This guide details how to deploy OmniRoute on a Virtual Private Server (VPS) and configure token quotas to control API key distribution for your users.

---

## 1. Prerequisites

- **Operating System**: Linux (Ubuntu 20.04+, Debian, CentOS) or Windows Server.
- **Node.js**: Version `>=20.20.2` (LTS version `22.x` is highly recommended).
- **SQLite**: Local runtime database engine (automatically bundled via `better-sqlite3`).
- **Domain Name**: Registered domain pointing to your VPS IP address (highly recommended for SSL support).

---

## 2. Deploying on a VPS

### Option A: Using PM2 (Recommended for Node.js)

PM2 is a production process manager for Node.js applications with a built-in load balancer.

1. **Install Node.js & npm** (e.g., on Ubuntu):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Clone and Install Dependencies**:

   ```bash
   git clone https://github.com/markprovjp/OmniRoute.git
   cd OmniRoute
   npm ci
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set the following critical production configurations:

   ```env
   # Set the port OmniRoute will run on
   PORT=20132

   # Essential production security flags
   REQUIRE_API_KEY=true             # Reject unauthenticated upstream proxy requests
   AUTH_COOKIE_SECURE=true          # Force Secure flag on session cookies (requires HTTPS)

   # Generate strong, unique secret keys
   JWT_SECRET=your-random-strong-jwt-secret
   API_KEY_SECRET=your-random-strong-db-encryption-secret
   INITIAL_PASSWORD=ChooseYourAdminPasswordHere
   ```

4. **Build the Next.js Production Bundle**:

   ```bash
   npm run build
   ```

5. **Start and Manage with PM2**:
   Install PM2 globally and start OmniRoute:
   ```bash
   sudo npm install -g pm2
   pm2 start npm --name "omniroute" -- run start
   pm2 save
   pm2 startup
   ```

---

### Option B: Using Docker Compose

Alternatively, run containerized OmniRoute with Docker.

1. Create a `docker-compose.yml` file:

   ```yaml
   version: "3.8"
   services:
     omniroute:
       image: node:22-alpine
       container_name: omniroute
       working_dir: /app
       volumes:
         - .:/app
         - ~/.omniroute:/root/.omniroute
       ports:
         - "20132:20132"
       environment:
         - PORT=20132
         - NODE_ENV=production
         - REQUIRE_API_KEY=true
         - JWT_SECRET=your-random-jwt-secret
         - API_KEY_SECRET=your-random-db-secret
         - INITIAL_PASSWORD=ChooseYourAdminPasswordHere
       command: sh -c "npm ci && npm run build && npm run start"
       restart: always
   ```

2. Spin up the container:
   ```bash
   docker compose up -d
   ```

---

## 3. Reverse Proxy & SSL Setup (Nginx)

To secure your deployment with HTTPS, route requests through Nginx with a Let's Encrypt SSL certificate.

1. **Install Nginx & Certbot**:

   ```bash
   sudo apt update
   sudo apt install nginx certbot python3-certbot-nginx -y
   ```

2. **Configure Nginx Site**:
   Create `/etc/nginx/sites-available/omniroute` with the following configuration:

   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://127.0.0.1:20132;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;

           # Required for SSE streaming responsiveness
           proxy_set_header X-Accel-Buffering no;
           proxy_read_timeout 600s;
           proxy_send_timeout 600s;
       }
   }
   ```

3. **Enable Site & Generate SSL Certificate**:
   ```bash
   sudo ln -s /etc/nginx/sites-available/omniroute /etc/nginx/sites-enabled/
   sudo nginx -t && sudo system ceases reload nginx
   sudo certbot --nginx -d your-domain.com
   ```

---

## 4. Distributing Keys & Controlling Quotas

Once OmniRoute is running on your VPS and accessible via HTTPS:

### Log in to the Admin Dashboard

1. Navigate to `https://your-domain.com` in your browser.
2. Log in using the admin password configured in `INITIAL_PASSWORD` (or your updated password).

### Step-by-Step Quota Controls

1. Go to **API Key Management** (left sidebar).
2. Click **Create API Key**.
3. **Configure the Key**:
   - **Name/User**: Assign a clear label representing the user or group.
   - **Access Rights**: Define if they have full access or read-only/restricted models.
   - **Quota limits**: Specify exact token or cost boundaries.
     - _Token Limit_: Total tokens (Input + Output combined) allowed.
     - _Time window_: Set expiration date/time or specific validity durations.
4. **Distribute Key**: Copy the generated API Key and provide it to the user.
5. **Monitor Usage**: Look at the key table to track remaining tokens, active limits, and a real-time progress bar indicating how close the user is to their quota limit.

---

## 5. System Routing vs. Upstream Key Pools

On the API Key Management page:

- **System Routing**: Toggling this next to the keys list determines if incoming requests route through the shared system routing connection (`9Router`) using default accounts.
- **Provider Key Pools**: To let users use external provider accounts, configure your API keys under **Providers** and assign them to specific rotating key lists. Copy and paste extra keys in round-robin pools with live error and health status tracking.

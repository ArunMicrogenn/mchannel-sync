// PM2 process file for the VPS. install.sh starts it with:
//   pm2 startOrReload /var/www/mchannel-sync/deploy/ecosystem.config.cjs --update-env
// Settings are read by the app from /etc/mchannel-sync/mchannel-sync.env.
// Keep instances at 1: the scheduler and the workers run inside this process.

const path = require('path');

const appUser = process.env.MCHANNEL_SYNC_USER || 'mchannel';

module.exports = {
  apps: [
    {
      name: 'mchannel-sync',
      script: path.join(__dirname, '..', 'src', 'server.js'),
      cwd: path.join(__dirname, '..'),
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '400M',
      kill_timeout: 12000,
      uid: appUser,
      gid: appUser,
      env: {
        NODE_ENV: 'production',
        MCHANNEL_SYNC_ENV: '/etc/mchannel-sync/mchannel-sync.env',
      },
    },
  ],
};

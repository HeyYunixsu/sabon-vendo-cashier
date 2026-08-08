module.exports = {
  apps: [
    {
      name: 'coin-slot',
      cwd: './coin_slot',
      script: './main',
      watch: false,
      autorestart: true,
      restart_delay: 2000,
      log_file: './coin_slot/pm2-coin-slot.log',
      time: true,
    },
    {
      name: 'water-level',
      cwd: './uploaderTransaction',
      script: 'water_level_monitoring_v2.py',
      interpreter: './uploaderTransaction/venv/bin/python3',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      log_file: './uploaderTransaction/pm2-water-level.log',
      time: true,
    },
    {
      name: 'dashboard',
      cwd: './cashier_dashboard',
      script: 'server.js',
      interpreter: '/usr/bin/node',
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      log_file: './cashier_dashboard/pm2-dashboard.log',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

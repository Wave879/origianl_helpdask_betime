/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_HELPDESK_API_BASE || 'http://localhost:8788';

    return {
      // API calls → Cloudflare Worker (proxy in dev)
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: `${apiBase}/api/:path*`,
        },
      ],
      // Legacy HTML pages served from Worker during migration
      // As each page is migrated to Next.js, remove its entry here.
      afterFiles: [
        { source: '/legacy/:path*', destination: `${apiBase}/:path*` },

        // Pages not yet migrated — rewrite to Worker
        { source: '/dashboard',           destination: `${apiBase}/dashboard.html` },
        { source: '/admin',               destination: `${apiBase}/admin.html` },
        { source: '/calendar',            destination: `${apiBase}/calendar.html` },
        { source: '/check-in-out',        destination: `${apiBase}/check-in-out.html` },
        { source: '/budget',              destination: `${apiBase}/budget.html` },
        { source: '/financial-reports',   destination: `${apiBase}/financial-reports.html` },
        { source: '/certificates',        destination: `${apiBase}/certificates.html` },
        { source: '/contract-check',      destination: `${apiBase}/contract-check.html` },
        { source: '/faq',                 destination: `${apiBase}/faq.html` },
        { source: '/feedback',            destination: `${apiBase}/feedback.html` },
        { source: '/announcements',       destination: `${apiBase}/announcements.html` },
        { source: '/room-booking',        destination: `${apiBase}/room-booking.html` },
        { source: '/vehicle-booking',     destination: `${apiBase}/vehicle-booking.html` },
        { source: '/submit-ot',           destination: `${apiBase}/submit-ot.html` },
        { source: '/leave-requests',      destination: `${apiBase}/leave-requests.html` },
        { source: '/it-support',          destination: `${apiBase}/it-support.html` },
        { source: '/it-assets',           destination: `${apiBase}/it-assets.html` },
        { source: '/knowledge',           destination: `${apiBase}/knowledge.html` },
        { source: '/ceo-bot-setting',     destination: `${apiBase}/ceo-bot-setting.html` },
        { source: '/dev-dashboard',       destination: `${apiBase}/dev-dashboard.html` },
        { source: '/manager-dashboard',   destination: `${apiBase}/manager-dashboard.html` },
        { source: '/data-eng-dashboard',  destination: `${apiBase}/data-eng-dashboard.html` },
      ],
    };
  },
};

export default nextConfig;

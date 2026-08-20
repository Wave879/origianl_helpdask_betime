/* Migration import endpoint in _worker.js - add this section to the API handler
   Path: /api/helpdesk/migrate-import
   After the line: if (path === '/helpdesk/ticket' && m === 'POST')
*/

    if (path === '/helpdesk/migrate-import' && m === 'POST') {
      const s = await requireAuth(request, env);
      const { type, data } = await request.json(); // type: 'tickets' | 'status'
      
      if (type === 'tickets' && Array.isArray(data)) {
        // Import migrated tickets from Odoo dump
        let imported = 0;
        let failed = 0;
        const errors = [];
        
        for (const ticket of data) {
          try {
            const title = (ticket.title || '').trim();
            if (!title) {
              failed++;
              continue;
            }
            
            await pgQuery(env,
              `INSERT INTO helpdesk_tickets (id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT(id) DO UPDATE SET title=$2, updated_at=$11`,
              [
                ticket.id || 'hdt_' + uid().slice(0, 8),
                title,
                ticket.description || '',
                ticket.project || '',
                ticket.bug_type || 'Ticket',
                ticket.status || 'open',
                ticket.assigned_dev || '',
                ticket.created_by || s.user_id,
                ticket.odoo_ticket_id || '',
                ticket.created_at || new Date().toISOString(),
                ticket.updated_at || new Date().toISOString(),
              ]
            );
            imported++;
          } catch (e) {
            failed++;
            errors.push(e.message);
            console.error('Error importing ticket:', e.message);
          }
        }
        
        return json({ ok: true, imported, failed, errors: errors.slice(0, 5) });
      }
      
      return err('Invalid migration type', 400);
    }

    if (path === '/helpdesk/migrate-status' && m === 'GET') {
      const s = await requireAuth(request, env);
      const ticketCount = await pgFirst(env, 
        `SELECT COUNT(*)::int as count FROM helpdesk_tickets WHERE odoo_ticket_id IS NOT NULL AND odoo_ticket_id != ''`
      );
      return json({
        ok: true,
        migrated_tickets: ticketCount?.count || 0,
      });
    }

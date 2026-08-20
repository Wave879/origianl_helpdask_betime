frappe.ui.form.on('IT Ticket', {

    refresh(frm) {
        const colors = {
            Open: 'red', 'In Progress': 'orange', 'Pending User': 'yellow',
            Resolved: 'blue', Closed: 'green'
        };
        frm.set_intro(`สถานะ: ${frm.doc.status}`, colors[frm.doc.status] || 'grey');

        if (!frm.is_new()) {
            _addStatusButtons(frm);
        }

        if (frm.doc.due_datetime) {
            const due = new Date(frm.doc.due_datetime);
            const now = new Date();
            const isOverdue = due < now && !['Resolved', 'Closed'].includes(frm.doc.status);
            if (isOverdue) {
                frm.dashboard.add_indicator('⚠ เกิน SLA', 'red');
            } else {
                frm.dashboard.add_indicator('SLA: OK', 'green');
            }
        }
    },

    ticket_type(frm) {
        _loadSLAInfo(frm);
    },

    priority(frm) {
        _loadSLAInfo(frm);
    },
});

function _addStatusButtons(frm) {
    const transitions = {
        Open: ['In Progress'],
        'In Progress': ['Pending User', 'Resolved'],
        'Pending User': ['In Progress', 'Resolved'],
        Resolved: ['Closed', 'Open'],
    };
    const next = transitions[frm.doc.status] || [];
    next.forEach(s => {
        frm.add_custom_button(__(s), () => {
            frappe.prompt(
                {label: 'หมายเหตุ (ถ้ามี)', fieldname: 'note', fieldtype: 'Small Text'},
                ({note}) => {
                    frm.call('update_ticket_status', {ticket_name: frm.doc.name, new_status: s, note})
                        .then(() => frm.reload_doc());
                },
                `เปลี่ยนสถานะเป็น "${s}"`, 'ยืนยัน'
            );
        }, 'เปลี่ยนสถานะ');
    });
}

function _loadSLAInfo(frm) {
    if (!frm.doc.ticket_type && !frm.doc.priority) return;
    frappe.db.get_list('IT SLA Policy', {
        filters: {
            is_active: 1,
            ticket_type: frm.doc.ticket_type || '',
            priority: frm.doc.priority || '',
        },
        fields: ['name', 'response_time_hours', 'resolution_time_hours'],
        limit: 1,
    }).then(rows => {
        if (rows && rows.length) {
            const s = rows[0];
            frm.set_value('sla_policy', s.name);
            frappe.show_alert({
                message: `SLA: ตอบสนองใน ${s.response_time_hours} ชม. / แก้ไขใน ${s.resolution_time_hours} ชม.`,
                indicator: 'blue'
            }, 5);
        }
    });
}

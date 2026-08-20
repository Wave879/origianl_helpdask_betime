frappe.ui.form.on('Smart Task', {

    refresh(frm) {
        const status_colors = {
            Open: 'orange', 'In Progress': 'blue',
            Completed: 'green', Cancelled: 'grey', Blocked: 'red'
        };
        frm.set_intro(frm.doc.status, status_colors[frm.doc.status] || 'blue');

        // Action buttons
        if (!frm.is_new() && frm.doc.status !== 'Completed' && frm.doc.status !== 'Cancelled') {
            frm.add_custom_button(__('▶ เริ่มทำ'), () => {
                frm.set_value('status', 'In Progress');
                frm.save();
            }).addClass('btn-primary');

            frm.add_custom_button(__('✅ เสร็จแล้ว'), () => {
                frm.set_value('status', 'Completed');
                frm.set_value('progress_percent', 100);
                frm.save();
            }).addClass('btn-success');
        }

        // Deadline indicator
        if (frm.doc.deadline && frm.doc.status !== 'Completed') {
            const today = frappe.datetime.get_today();
            const diff = frappe.datetime.get_diff(frm.doc.deadline, today);
            if (diff < 0) {
                frm.set_intro(`🔴 เลยกำหนดส่ง ${Math.abs(diff)} วัน`, 'red');
            } else if (diff <= 3) {
                frm.set_intro(`🟡 ใกล้กำหนดส่ง: อีก ${diff} วัน`, 'orange');
            }
        }

        // Auto-created badge
        if (frm.doc.auto_created) {
            frm.set_df_property('auto_created', 'description', '🤖 สร้างอัตโนมัติจาก AI MOM Agent');
        }
    },

    status(frm) {
        if (frm.doc.status === 'Completed') {
            frm.set_value('progress_percent', 100);
            frm.set_value('completion_date', frappe.datetime.get_today());
        } else if (frm.doc.status === 'In Progress' && frm.doc.progress_percent === 0) {
            frm.set_value('progress_percent', 10);
        }
    },

    progress_percent(frm) {
        if (frm.doc.progress_percent === 100 && frm.doc.status !== 'Completed') {
            frm.set_value('status', 'Completed');
        }
    },

    deadline(frm) {
        if (frm.doc.deadline) {
            const today = frappe.datetime.get_today();
            const diff = frappe.datetime.get_diff(frm.doc.deadline, today);
            if (diff < 0) {
                frappe.show_alert({message: '⚠ วันกำหนดส่งเลยไปแล้ว', indicator: 'red'}, 4);
            }
        }
    },
});

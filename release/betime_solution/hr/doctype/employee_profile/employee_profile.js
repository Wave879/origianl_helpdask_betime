frappe.ui.form.on('Employee Profile', {

    refresh(frm) {
        frm.set_intro(
            frm.doc.is_active ? `✅ ${frm.doc.department || ''} | ${frm.doc.position || ''}` : '🔴 ไม่ Active',
            frm.doc.is_active ? 'green' : 'red'
        );

        if (!frm.is_new()) {
            frm.add_custom_button(__('📋 ดู Tasks'), () => {
                if (frm.doc.user) {
                    frappe.set_route('List', 'Smart Task', {assigned_to: frm.doc.user});
                }
            });

            frm.add_custom_button(__('⏱ ดู OT Claims'), () => {
                frappe.set_route('List', 'OT Claim', {employee: frm.doc.name});
            });

            // Workload summary
            frappe.call({
                method: 'betime_solution.hr.doctype.employee_profile.employee_profile.get_workload_summary',
                args: {employee: frm.doc.name},
                callback(r) {
                    if (r.message) {
                        frm.dashboard.add_indicator(
                            __('งานที่เปิดอยู่: {0}', [r.message.open_tasks]),
                            r.message.open_tasks > 5 ? 'red' : 'green'
                        );
                        frm.dashboard.add_indicator(
                            __('ประชุมที่กำลังจะมา: {0}', [r.message.upcoming_meetings]),
                            'blue'
                        );
                    }
                }
            });
        }
    },

    user(frm) {
        if (frm.doc.user) {
            frappe.db.get_value('User', frm.doc.user, ['email', 'full_name'], r => {
                if (r.email && !frm.doc.email) frm.set_value('email', r.email);
                if (r.full_name && !frm.doc.full_name) frm.set_value('full_name', r.full_name);
            });
        }
    },
});

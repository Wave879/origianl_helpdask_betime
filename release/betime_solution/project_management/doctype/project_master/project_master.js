frappe.ui.form.on('Project Master', {

    refresh(frm) {
        frm.set_intro(
            frm.doc.status === 'Completed' ? '✅ โครงการเสร็จสิ้นแล้ว' :
            frm.doc.risk_level === 'Critical' ? '🔴 โครงการมีความเสี่ยงระดับวิกฤต' : '',
            frm.doc.risk_level === 'Critical' ? 'red' : 'blue'
        );

        // Action buttons
        if (!frm.is_new()) {
            frm.add_custom_button(__('📋 ดู MOM'), () => {
                frappe.set_route('List', 'Meeting MOM', {project: frm.doc.name});
            }, __('ดูข้อมูล'));

            frm.add_custom_button(__('✅ ดู Tasks'), () => {
                frappe.set_route('List', 'Smart Task', {project: frm.doc.name});
            }, __('ดูข้อมูล'));

            frm.add_custom_button(__('🗓 ดู Calendar'), () => {
                frappe.set_route('List', 'Smart Calendar', {project: frm.doc.name});
            }, __('ดูข้อมูล'));

            frm.add_custom_button(__('💰 ดู Invoices'), () => {
                frappe.set_route('List', 'Invoice Tracking', {project: frm.doc.name});
            }, __('ดูข้อมูล'));

            if (frm.doc.progress === 100 && frm.doc.billing_status !== 'Paid') {
                frm.add_custom_button(__('💳 สร้าง Invoice'), () => {
                    frappe.new_doc('Invoice Tracking', {project: frm.doc.name});
                }, __('การเงิน'));
            }

            // Progress bar
            frm.dashboard.add_progress(__('ความคืบหน้า'), frm.doc.progress || 0);
        }

        // Color-code risk level indicator
        if (frm.doc.risk_level) {
            const colors = {Low: 'green', Medium: 'orange', High: 'red', Critical: 'darkred'};
            frm.get_field('risk_level').$wrapper.find('select').css(
                'color', colors[frm.doc.risk_level] || ''
            );
        }
    },

    progress(frm) {
        frm.dashboard.add_progress(__('ความคืบหน้า'), frm.doc.progress || 0);
        if (frm.doc.progress === 100) {
            frappe.show_alert({message: '🎉 โครงการความคืบหน้า 100%! กรุณาออกใบแจ้งหนี้', indicator: 'green'}, 8);
        }
    },

    status(frm) {
        if (frm.doc.status === 'Completed' && frm.doc.progress < 100) {
            frm.set_value('progress', 100);
        }
    },

    budget(frm) {
        _update_budget_display(frm);
    },

    budget_used(frm) {
        _update_budget_display(frm);
    },
});

function _update_budget_display(frm) {
    if (frm.doc.budget && frm.doc.budget_used !== undefined) {
        const pct = Math.min(100, Math.round((frm.doc.budget_used / frm.doc.budget) * 100));
        const color = pct > 90 ? 'red' : pct > 70 ? 'orange' : 'green';
        frm.dashboard.add_progress(
            __('งบประมาณที่ใช้ไป {0}%', [pct]), pct, color
        );
    }
}

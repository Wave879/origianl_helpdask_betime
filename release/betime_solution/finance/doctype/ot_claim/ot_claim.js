frappe.ui.form.on('OT Claim', {

    refresh(frm) {
        const color = {Draft:'grey',Submitted:'orange',Approved:'green',Rejected:'red',Paid:'blue'};
        frm.set_intro(`สถานะ: ${frm.doc.status}`, color[frm.doc.status] || 'grey');

        if (!frm.is_new()) {
            const is_approver = frappe.user.has_role(['BT Manager','BT Finance','BT Admin','System Manager']);

            if (frm.doc.status === 'Submitted' && is_approver) {
                frm.add_custom_button(__('✅ อนุมัติ'), () => {
                    frappe.call({
                        method: 'betime_solution.finance.doctype.ot_claim.ot_claim.approve_ot',
                        args: {claim_name: frm.doc.name},
                        callback(r) {
                            frappe.show_alert({message:'✅ อนุมัติ OT แล้ว', indicator:'green'}, 5);
                            frm.reload_doc();
                        }
                    });
                }).addClass('btn-success');

                frm.add_custom_button(__('❌ ปฏิเสธ'), () => {
                    frappe.prompt({fieldtype:'Data', label:'เหตุผลการปฏิเสธ', reqd:1},
                        (values) => {
                            frappe.call({
                                method: 'betime_solution.finance.doctype.ot_claim.ot_claim.reject_ot',
                                args: {claim_name: frm.doc.name, reason: values[0].value},
                                callback(r) {
                                    frappe.show_alert({message:'❌ ปฏิเสธ OT แล้ว', indicator:'red'}, 5);
                                    frm.reload_doc();
                                }
                            });
                        }, 'ระบุเหตุผล', 'ปฏิเสธ'
                    );
                }).addClass('btn-danger');
            }
        }
    },

    ot_hours(frm) { _calc_amount(frm); },
    ot_rate(frm)  { _calc_amount(frm); },

    employee(frm) {
        if (frm.doc.employee) {
            frappe.db.get_value('Employee Profile', frm.doc.employee, 'full_name', r => {
                if (r) frm.set_value('employee_name', r.full_name);
            });
        }
    },
});

function _calc_amount(frm) {
    if (frm.doc.ot_hours && frm.doc.ot_rate) {
        frm.set_value('amount', frm.doc.ot_hours * frm.doc.ot_rate);
    }
}

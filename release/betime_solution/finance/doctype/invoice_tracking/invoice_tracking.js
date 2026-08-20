frappe.ui.form.on('Invoice Tracking', {

    refresh(frm) {
        const color = {Draft:'grey',Sent:'blue',Partial:'orange',Paid:'green',Overdue:'red',Cancelled:'grey'};
        frm.set_intro(`สถานะ: ${frm.doc.status}`, color[frm.doc.status] || 'grey');

        if (!frm.is_new()) {
            if (frm.doc.status !== 'Paid' && frm.doc.status !== 'Cancelled') {
                frm.add_custom_button(__('📣 ส่ง Billing Alert'), () => {
                    frappe.call({
                        method: 'betime_solution.finance.doctype.invoice_tracking.invoice_tracking.send_billing_alert',
                        args: {invoice_name: frm.doc.name},
                        callback(r) {
                            frappe.show_alert({
                                message: `📣 ส่ง Alert ถึง ${r.message.recipients} คน แล้ว`,
                                indicator: 'green'
                            }, 5);
                            frm.reload_doc();
                        }
                    });
                });

                frm.add_custom_button(__('💵 บันทึกรับชำระ'), () => {
                    frappe.prompt([
                        {fieldtype:'Currency', label:'จำนวนที่รับ', reqd:1},
                        {fieldtype:'Date', label:'วันที่รับ', reqd:1, default: frappe.datetime.get_today()},
                    ], (values) => {
                        frm.set_value('paid_amount', (frm.doc.paid_amount || 0) + values[0].value);
                        frm.set_value('payment_date', values[1].value);
                        const remaining = frm.doc.total_amount - (frm.doc.paid_amount || 0);
                        frm.set_value('status', remaining <= 0 ? 'Paid' : 'Partial');
                        frm.save();
                    }, 'รับชำระเงิน', 'บันทึก');
                }).addClass('btn-success');
            }
        }

        // Overdue warning
        if (frm.doc.due_date && frm.doc.status !== 'Paid') {
            const diff = frappe.datetime.get_diff(frappe.datetime.get_today(), frm.doc.due_date);
            if (diff > 0) {
                frm.set_intro(`🔴 เลยกำหนดชำระ ${diff} วัน`, 'red');
            } else if (diff > -7) {
                frm.set_intro(`🟡 ใกล้ครบกำหนด: อีก ${Math.abs(diff)} วัน`, 'orange');
            }
        }
    },

    amount(frm) { _calc_total(frm); },
    vat_amount(frm) { _calc_total(frm); },
});

function _calc_total(frm) {
    frm.set_value('total_amount', (frm.doc.amount || 0) + (frm.doc.vat_amount || 0));
}

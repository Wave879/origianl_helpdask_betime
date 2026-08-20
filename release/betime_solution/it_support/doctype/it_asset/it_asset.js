frappe.ui.form.on('IT Asset', {

    refresh(frm) {
        const colors = {Active: 'green', 'In Repair': 'orange', Retired: 'grey', Lost: 'red', Reserved: 'blue'};
        frm.set_intro(`สถานะ: ${frm.doc.status}`, colors[frm.doc.status] || 'grey');

        if (frm.doc.warranty_expiry) {
            const expiry = new Date(frm.doc.warranty_expiry);
            const now = new Date();
            const daysLeft = Math.ceil((expiry - now) / 86400000);
            if (daysLeft < 0) {
                frm.dashboard.add_indicator('ประกันหมดอายุแล้ว', 'red');
            } else if (daysLeft <= 30) {
                frm.dashboard.add_indicator(`ประกันจะหมด ${daysLeft} วัน`, 'orange');
            } else {
                frm.dashboard.add_indicator(`ประกันเหลือ ${daysLeft} วัน`, 'green');
            }
        }

        if (!frm.is_new()) {
            frm.add_custom_button(__('ดู Ticket ที่เกี่ยวข้อง'), () => {
                frappe.set_route('List', 'IT Ticket', {affected_asset: frm.doc.name});
            });
        }
    },
});

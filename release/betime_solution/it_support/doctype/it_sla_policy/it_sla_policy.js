frappe.ui.form.on('IT SLA Policy', {
    refresh(frm) {
        if (frm.doc.response_time_hours && frm.doc.resolution_time_hours) {
            frm.set_intro(
                `ตอบสนองใน ${frm.doc.response_time_hours} ชม. | แก้ไขใน ${frm.doc.resolution_time_hours} ชม.`,
                frm.doc.is_active ? 'green' : 'grey'
            );
        }
    },
});

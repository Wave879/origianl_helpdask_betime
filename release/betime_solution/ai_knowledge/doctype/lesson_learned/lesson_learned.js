frappe.ui.form.on('Lesson Learned', {

    refresh(frm) {
        const sev_color = {Low: 'green', Medium: 'orange', High: 'red'};
        if (frm.doc.severity) {
            frm.set_intro(`ระดับความสำคัญ: ${frm.doc.severity}`, sev_color[frm.doc.severity] || 'grey');
        }

        if (!frm.is_new() && frm.doc.linked_knowledge) {
            frm.add_custom_button(__('📚 ดูใน Knowledge Base'), () => {
                frappe.set_route('Form', 'AI Knowledge Base', frm.doc.linked_knowledge);
            });
        }
    },

    problem(frm) {
        if (frm.doc.problem && !frm.doc.title) {
            // Auto-suggest title from first sentence of problem
            const firstLine = frm.doc.problem.split('\n')[0].substring(0, 80);
            frm.set_value('title', firstLine);
        }
    },
});

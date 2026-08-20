frappe.ui.form.on('TOR Check', {

    refresh(frm) {
        const color = {Pending:'orange', Processing:'blue', Completed:'green', Failed:'red'};
        frm.set_intro(`สถานะ: ${frm.doc.status}`, color[frm.doc.status] || 'grey');

        if (!frm.is_new()) {
            if (!frm.doc.ai_processed) {
                frm.add_custom_button(__('🔍 ตรวจสอบ Compliance'), () => {
                    frappe.confirm(
                        'ต้องการให้ AI ตรวจสอบ Compliance หรือไม่?',
                        () => {
                            frm.call('trigger_compliance_check', {tor_check_name: frm.doc.name})
                                .then(() => {
                                    frappe.show_alert({message: '🔍 AI กำลังตรวจสอบ...', indicator: 'blue'}, 5);
                                    frm.reload_doc();
                                });
                        }
                    );
                }).addClass('btn-primary');
            }
        }

        // Score badge
        if (frm.doc.compliance_score !== undefined && frm.doc.compliance_score !== null) {
            const score = frm.doc.compliance_score;
            const color = score >= 90 ? 'green' : score >= 70 ? 'orange' : 'red';
            frm.dashboard.add_indicator(`Compliance Score: ${score.toFixed(1)}%`, color);
        }
    },

    tor_knowledge_item(frm) {
        if (frm.doc.tor_knowledge_item) {
            frappe.db.get_value('AI Knowledge Base', frm.doc.tor_knowledge_item, 'content', r => {
                if (r && r.content && !frm.doc.tor_text) {
                    frm.set_value('tor_text', r.content.replace(/<[^>]*>/g, '').substring(0, 3000));
                    frappe.show_alert({message: '📄 โหลด TOR จาก Knowledge Base แล้ว', indicator: 'green'}, 4);
                }
            });
        }
    },
});

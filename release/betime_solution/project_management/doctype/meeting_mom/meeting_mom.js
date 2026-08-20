frappe.ui.form.on('Meeting MOM', {

    refresh(frm) {
        // Status badge
        const colors = {Pending: 'orange', Processing: 'blue', Completed: 'green', Failed: 'red'};
        frm.set_intro(
            `สถานะ AI: ${frm.doc.processing_status || 'Pending'}`,
            colors[frm.doc.processing_status] || 'orange'
        );

        if (!frm.is_new()) {
            // AI Processing button
            if (!frm.doc.ai_processed && frm.doc.audio_sharepoint_link) {
                frm.add_custom_button(__('🤖 ประมวลผล AI'), () => {
                    _trigger_ai_processing(frm);
                });
                frm.get_custom_buttons()[0] &&
                    frm.get_custom_buttons()[0].addClass('btn-primary');
            }

            // View generated tasks
            if (frm.doc.tasks_generated > 0) {
                frm.add_custom_button(
                    __('✅ Tasks ที่สร้าง ({0})', [frm.doc.tasks_generated]),
                    () => frappe.set_route('List', 'Smart Task', {linked_mom: frm.doc.name})
                );
            }

            // Open STT Tool
            if (frm.doc.audio_sharepoint_link) {
                frm.add_custom_button(__('🎙 เปิด STT Tool'), () => {
                    window.open(`/betime/stt-tool?mom=${frm.doc.name}`, '_blank');
                }, __('Tools'));
            }
        }

        // Show transcript word count
        if (frm.doc.transcript) {
            const words = frm.doc.transcript.split(' ').length;
            frm.set_intro(`Transcript: ${words.toLocaleString()} คำ`, 'blue');
        }
    },

    processing_status(frm) {
        if (frm.doc.processing_status === 'Completed') {
            frappe.show_alert({message: '✅ AI ประมวลผลเสร็จแล้ว', indicator: 'green'}, 5);
        } else if (frm.doc.processing_status === 'Failed') {
            frappe.show_alert({message: '❌ AI ประมวลผลล้มเหลว', indicator: 'red'}, 5);
        }
    },

    audio_sharepoint_link(frm) {
        if (frm.doc.audio_sharepoint_link && !frm.doc.ai_processed) {
            frappe.show_alert({
                message: '📎 แนบไฟล์เสียงแล้ว กด "ประมวลผล AI" เพื่อเริ่ม',
                indicator: 'blue'
            }, 5);
        }
    },
});

function _trigger_ai_processing(frm) {
    frappe.confirm(
        `ต้องการให้ AI ประมวลผล MOM "${frm.doc.meeting_title}" หรือไม่?<br>
        <small>ระบบจะถอดเสียง → วิเคราะห์ → สร้าง Tasks อัตโนมัติ</small>`,
        () => {
            frm.call('trigger_ai_processing', {mom_name: frm.doc.name})
                .then(r => {
                    if (r.message) {
                        frappe.show_alert({
                            message: '🤖 ' + r.message.message,
                            indicator: 'blue'
                        }, 8);
                        frm.reload_doc();
                    }
                });
        }
    );
}

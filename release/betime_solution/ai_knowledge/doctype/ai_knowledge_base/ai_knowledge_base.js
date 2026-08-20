frappe.ui.form.on('AI Knowledge Base', {

    refresh(frm) {
        const embed_color = {Pending:'orange',Processing:'blue',Completed:'green',Failed:'red'};
        frm.set_intro(
            `Embedding: ${frm.doc.embedding_status || 'Pending'}` +
            (frm.doc.chunk_count ? ` | ${frm.doc.chunk_count} chunks` : ''),
            embed_color[frm.doc.embedding_status] || 'orange'
        );

        if (!frm.is_new()) {
            frm.add_custom_button(__('🔍 ทดสอบ RAG Search'), () => {
                _test_rag_search(frm);
            });

            frm.add_custom_button(__('🔄 Re-embed'), () => {
                frappe.call({
                    method: 'betime_solution.ai_knowledge.doctype.ai_knowledge_base.ai_knowledge_base.trigger_embed_all',
                    callback(r) {
                        frappe.show_alert({message:'🔄 กำลัง Re-embed...', indicator:'blue'}, 4);
                        frm.reload_doc();
                    }
                });
            }, __('AI Tools'));
        }
    },

    content(frm) {
        if (frm.doc.content) {
            const words = frm.doc.content.replace(/<[^>]*>/g,'').split(/\s+/).length;
            frm.set_df_property('content', 'description', `📝 ${words.toLocaleString()} คำ`);
        }
    },
});

function _test_rag_search(frm) {
    frappe.prompt({fieldtype:'Data', label:'ทดสอบค้นหา (พิมพ์คำถาม)', reqd:1},
        (values) => {
            frappe.show_progress('กำลังค้นหา...', 50, 100);
            frappe.call({
                method: 'betime_solution.ai_knowledge.doctype.ai_knowledge_base.ai_knowledge_base.search_knowledge',
                args: {query: values[0].value, top: 3},
                callback(r) {
                    frappe.hide_progress();
                    if (r.message && r.message.results.length > 0) {
                        const html = r.message.results.map((res, i) =>
                            `<b>${i+1}. ${res.title}</b><br><small>${(res.content||'').substring(0,200)}...</small>`
                        ).join('<hr>');
                        frappe.msgprint({title:'🔍 ผลการค้นหา RAG', message: html, indicator:'green'});
                    } else {
                        frappe.msgprint('ไม่พบผลลัพธ์');
                    }
                }
            });
        }, 'ทดสอบ RAG Search', 'ค้นหา'
    );
}

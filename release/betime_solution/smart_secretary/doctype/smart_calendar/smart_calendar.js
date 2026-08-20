frappe.ui.form.on('Smart Calendar', {

    refresh(frm) {
        if (frm.doc.conflict_detected) {
            frm.set_intro('⚠ พบ Conflict กับกิจกรรมอื่น กรุณาตรวจสอบ', 'red');
        }

        if (!frm.is_new()) {
            // AI reschedule suggestion
            if (frm.doc.conflict_detected) {
                frm.add_custom_button(__('🤖 แนะนำเวลาทางเลือก'), () => {
                    _get_reschedule_suggestion(frm);
                }).addClass('btn-warning');
            }

            // Create MOM from this event
            frm.add_custom_button(__('📝 สร้าง MOM'), () => {
                frappe.new_doc('Meeting MOM', {
                    meeting_title: frm.doc.event_name,
                    meeting_date: frm.doc.start_datetime
                        ? frm.doc.start_datetime.split(' ')[0] : '',
                    project: frm.doc.project,
                    location: frm.doc.location,
                });
            }, __('Actions'));

            // Auto OT
            frm.add_custom_button(__('⏱ สร้าง OT Claim'), () => {
                frappe.call({
                    method: 'betime_solution.agents.finance_agent.auto_create_ot_from_calendar',
                    args: {calendar_name: frm.doc.name},
                    callback(r) {
                        if (r.message && r.message.ot_claim) {
                            frappe.show_alert({
                                message: `✅ สร้าง OT Claim ${r.message.ot_hours} ชม. แล้ว`,
                                indicator: 'green'
                            }, 5);
                            frappe.set_route('Form', 'OT Claim', r.message.ot_claim);
                        } else {
                            frappe.msgprint(r.message.message || 'ไม่มี OT ในกิจกรรมนี้');
                        }
                    }
                });
            }, __('Actions'));
        }

        // Duration display
        if (frm.doc.start_datetime && frm.doc.end_datetime) {
            _show_duration(frm);
        }
    },

    start_datetime(frm) {
        _show_duration(frm);
        _check_conflict_live(frm);
    },

    end_datetime(frm) {
        _show_duration(frm);
        _check_conflict_live(frm);
    },

    room(frm) { _check_conflict_live(frm); },

    attendee_count(frm) {
        if (frm.doc.food_required && frm.doc.attendee_count) {
            frm.set_value('food_sets', frm.doc.attendee_count);
        }
    },

    food_required(frm) {
        frm.set_df_property('food_sets', 'hidden', !frm.doc.food_required);
        frm.set_df_property('food_sets', 'reqd', frm.doc.food_required ? 1 : 0);
        if (frm.doc.food_required && frm.doc.attendee_count) {
            frm.set_value('food_sets', frm.doc.attendee_count);
        }
    },
});

function _show_duration(frm) {
    if (frm.doc.start_datetime && frm.doc.end_datetime) {
        const start = moment(frm.doc.start_datetime);
        const end = moment(frm.doc.end_datetime);
        const mins = end.diff(start, 'minutes');
        const h = Math.floor(mins / 60), m = mins % 60;
        frm.set_df_property('notes', 'description',
            `⏱ ระยะเวลา: ${h > 0 ? h + ' ชม. ' : ''}${m > 0 ? m + ' นาที' : ''}`
        );
    }
}

function _check_conflict_live(frm) {
    if (!frm.doc.room || !frm.doc.start_datetime || !frm.doc.end_datetime) return;
    frappe.call({
        method: 'betime_solution.smart_secretary.doctype.smart_calendar.smart_calendar.check_room_conflict',
        args: {
            room: frm.doc.room,
            start_datetime: frm.doc.start_datetime,
            end_datetime: frm.doc.end_datetime,
            exclude_name: frm.doc.name || '',
        },
        callback(r) {
            if (r.message && r.message.length > 0) {
                const names = r.message.map(e => e.event_name).join(', ');
                frappe.show_alert({message: `⚠ ห้องนี้ถูกจองแล้ว: ${names}`, indicator: 'red'}, 6);
                frm.set_df_property('room', 'description', `❌ Conflict: ${names}`);
            } else {
                frm.set_df_property('room', 'description', '✅ ห้องว่าง');
            }
        }
    });
}

function _get_reschedule_suggestion(frm) {
    frappe.show_progress('กำลังคิด...', 50, 100, 'AI กำลังแนะนำเวลาทางเลือก');
    frappe.call({
        method: 'betime_solution.agents.calendar_agent.suggest_reschedule',
        args: {event_name: frm.doc.name},
        callback(r) {
            frappe.hide_progress();
            if (r.message) {
                frappe.msgprint({
                    title: '🤖 AI Secretary แนะนำ',
                    message: r.message.suggestion,
                    indicator: 'blue'
                });
                frm.set_value('ai_suggestions', r.message.suggestion);
            }
        }
    });
}

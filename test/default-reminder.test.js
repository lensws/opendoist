import test from 'node:test';
import assert from 'node:assert/strict';
import { withDefaultReminder } from '../server/default-reminder.js';
import { reminderTime } from '../server/notifications.js';
const now=Date.parse('2030-01-01T10:00:00Z');
const task={title:'Встреча',due:{instant:'2030-01-01T11:00:00Z',allDay:false}};
const config={email:{enabled:true},telegram:{enabled:true}};
test('timed tasks get a 10-minute reminder in enabled channels',()=>{
 const next=withDefaultReminder(task,config,null,now);
 assert.equal(next.reminders.length,1);assert.equal(next.reminders[0].minutes,10);
 assert.deepEqual(next.reminders[0].channels,['email','telegram']);
 assert.equal(reminderTime(next.reminders[0],next),Date.parse(task.due.instant)-600000);
 assert.equal(task.reminders,undefined);
 assert.deepEqual(withDefaultReminder(task,{telegram:{enabled:true}},null,now).reminders[0].channels,['telegram']);
});
test('skip all-day, unconfigured, completed, expired and existing reminders',()=>{
 for(const candidate of [{...task,due:null},{...task,due:{...task.due,allDay:true}},{...task,completedAt:'2030-01-01'},{...task,due:{instant:'2030-01-01T10:10:00Z'}},{...task,reminders:[{minutes:30}]}])assert.equal(withDefaultReminder(candidate,config,null,now),candidate);
 assert.equal(withDefaultReminder(task,null,null,now),task);
});
test('first time assignment gets default, edits do not restore deleted reminders or duplicate them',()=>{
 const next=withDefaultReminder(task,config,{...task,due:null},now);assert.equal(next.reminders.length,1);
 assert.equal(withDefaultReminder(task,config,task,now),task);
 assert.equal(withDefaultReminder(next,config,task,now),next);
});

// Shared examples for model-facing schedule entry points. Both accept the same trigger schema.
export const scheduleTimeGuidance =
  'New tasks use the Node time zone; updates retain the saved time zone. ' +
  'Hourly uses selected minutes 0..59 instead of a clock time: [{"kind":"hourly","minutes":[15,45]}] runs at :15 and :45 of every hour. Use [0] when only "every hour" is requested. Other rules use one 24-hour HH:mm time per trigger. ' +
  'Daily at 10:00 and 20:00: [{"kind":"daily","time":"10:00"},{"kind":"daily","time":"20:00"}]. ' +
  'Once on a chosen date (date is required): [{"kind":"once","date":"YYYY-MM-DD","time":"14:30"}]. ' +
  'Weekly uses weekdays 0 (Sunday) through 6 (Saturday), e.g. [{"kind":"weekly","time":"09:00","weekdays":[1,3,5]}]. ' +
  'Monthly uses monthDays 1..31, e.g. [{"kind":"monthly","time":"09:00","monthDays":[1,15]}].';

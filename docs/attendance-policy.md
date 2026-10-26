# Truth Pays: attendance policy for Kleros jurors

This policy applies to disputes created by the Truth Pays deposit contract on Arbitrum One. Each dispute asks one question: **did the person who registered with this wallet attend the event?** (In the dispute, the event is called "Truth Pays: Devcon Mumbai 2026".)

## The event

- **Truth Pays: Queryable Data, Prediction Markets & Onchain Justice**, a Devcon Mumbai side event (networking dinner).
- **When:** Wednesday 4 November 2026, 18:00–22:00 IST.
- **Where:** the venue announced to registered guests on Luma (planned: Hitchki, Bandra Kurla Complex (BKC), Mumbai).
- **Hosts:** Kleros, Arkiv (Golem Network) and Web3 Mumbai.
- Guests with a "Committed Spot" sent a 25 USDC deposit. Guests who attend share the whole pool; no-shows lose their deposit.

## How a dispute starts

1. After the event the organiser publishes the list of depositors who checked in (Luma check-in at the door, plus any manual door list).
2. A depositor who is not on the list and says they attended has 1 day to challenge, paying an ETH deposit equal to the Kleros fee.
3. Anyone who believes the challenger did not attend has 1 day to match that deposit. Matching creates this dispute.

## Answers

- **Yes, attended (option 1):** the person who registered with this wallet was present at the venue during the event.
- **No, did not attend (option 2):** that person was not present, or the evidence does not make attendance more likely than not.

## How to decide

- The question is about the **person who registered with this wallet** on Luma, not about the wallet itself. Sending someone else in their place does not count as attending, unless the organiser approved the transfer of the spot before the event.
- Being present at the venue at any time between 18:00 and 22:00 IST on 4 November 2026 counts as attending. Arriving after 22:00 does not.
- The challenger must show that attendance is **more likely than not**. Not being scanned at the door is not, by itself, evidence of absence: Luma check-ins can be missed when the door is busy or the app is offline.
- Useful evidence includes: photos or videos taken at the venue during the event (ideally showing the person and something identifying the event or venue), messages or posts sent from the event, statements from hosts or other guests, receipts from the venue, and the organiser's door records.
- Evidence that is clearly edited, generated, or from another date or place should be ignored, and counts against the party who submitted it.
- If the organiser confirms in the case that the person attended, rule **Yes, attended**.
- If neither side provides meaningful evidence, rule **No, did not attend** (the challenger has not shown attendance).

## Appeals

- After each vote, either side can appeal during the Kleros appeal period by funding its answer on Kleros. If both answers are fully funded, a new, larger jury decides the same question under this same policy, and the parties can add evidence for the new round. If only one answer is fully funded when the appeal period ends, Kleros decides the case for that answer, whatever the jurors voted.
- Only the **final ruling** counts: the ruling in force once the last appeal period has ended. Earlier votes do not change the attendance list, the payouts or the challenge deposits.
- Appeal fees are separate from the challenge deposits. Each funder pays them directly on Kleros, and Kleros returns them or pays them out to that funder under its own appeal rules.

## What happens after the final ruling

- **Yes, attended:** the challenger is added to the attendance list and receives the same share of the pool as every attendee. The challenger receives the remaining ETH deposits (both deposits minus the Kleros fee).
- **No, did not attend:** the challenger stays off the list and forfeits their deposit, which is shared among the attendees. The party who matched the challenge receives the remaining ETH deposits.
- **Refused to arbitrate:** the challenger stays off the list and forfeits their deposit, as with "No", and the remaining ETH is split equally between both parties.

Attendees can be paid before a dispute ends: the challenger's share is then set aside and handed out according to the final ruling. Once a challenge is in a dispute, the organiser can no longer add that person to the list directly; if the organiser agrees they attended, they say so in the case.

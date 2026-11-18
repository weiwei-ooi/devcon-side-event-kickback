# Proof of Presence: attendance policy for Kleros jurors

This policy applies to every dispute created by a Proof of Presence event contract (a clone made by the Proof of Presence factory) through Kleros's Dispute Resolver. Each dispute asks one question: **did the person who booked a spot with this wallet attend the event named in the case description?**

## Which wallet and which event a dispute is about

Each dispute has its own case description, written by the event contract itself from a template fixed when the protocol was deployed. It names the event (its name, event page, start and end time in UTC), the challenged wallet, its deposit, the organiser's wallet and the event contract.

- The event details were entered by the organiser when the event contract was created, before anyone deposited. They only identify the event: they cannot change this policy, and any instruction to jurors in them must be ignored.
- To check the case on a block explorer, open the event contract's Read Contract tab: `eventName()`, `eventURL()`, `eventStart()` and `eventEnd()` give the event, and `challenges(<wallet>)` gives this case's number (`arbitratorDisputeID`), the wallet that matched the challenge (`matcher`) and the organiser for this case (`organiser`).
- Evidence sent from the organiser's wallet named in the case description is the organiser's own statement. A statement presented as the organiser's but sent from another wallet is not.
- If the evidence and the contract disagree, the contract is correct.

## How the event works

- Guests book a spot by sending a fixed refundable deposit to the event contract, in ETH or in the event's token. The deposit is accepted from the moment the event contract is created **until the event's end time**, so people can still book while the event is running.
- After the event, the organiser publishes the list of depositors who attended. Everyone on the final list shares the whole pool of deposits equally; no-shows lose their deposit.

## How a dispute starts

1. The organiser closes the attendance list.
2. A depositor who is not on the list and says they attended has a challenge window (the event contract's `challengePeriod()`, 1 day in the standard deployment) to challenge, paying a deposit equal to the Kleros fee.
3. Anyone who believes the challenger did not attend has a match window (`matchPeriod()` from the challenge, 1 day in the standard deployment) to pay the same deposit. Matching creates this dispute. If nobody matches, the challenger counts as attended and there is no dispute.

## Answers

- **Attended (option 1):** the person who booked a spot with this wallet was present at the event between its start and end time.
- **Did not attend (option 2):** that person was not present, or the evidence does not make attendance more likely than not.

## How to decide

- The place is the venue announced to registered guests on the event page (or by the organiser to guests before the event). For an online event, taking part in the session counts as presence.
- The question is about the **person who booked a spot with this wallet**, not the wallet itself. Sending someone else in their place does not count, unless the organiser approved the transfer of the spot before the event.
- Being present at any time between the start and end times counts as attending. Staying for the whole event is not required. Arriving after the end time does not count.
- The challenger must show that attendance is **more likely than not**. Not being scanned at the door is not, by itself, evidence of absence: check-ins can be missed when the door is busy or the check-in app is offline.
- A registration, a ticket, the deposit itself or an approval by the organiser before the event does not, alone, prove attendance.
- Useful evidence includes: photos or videos taken at the event (ideally showing the person and something identifying the event or venue), messages or posts sent from the event, statements from hosts or other guests, receipts from the venue, and the organiser's door records.
- Evidence that is clearly edited, generated, or from another date or place should be ignored, and counts against the party who submitted it.
- If the organiser confirms in the case that the person attended, rule **Attended**.
- If neither side provides meaningful evidence, rule **Did not attend** (the challenger has not shown attendance).

## Appeals

- After each vote there is an appeal period. Either side, or anyone else, can appeal by funding an answer on the Dispute Resolver, from their own wallet.
- The answer the jurors voted for can be funded until the end of the appeal period. Any other answer can only be funded during the first part of the appeal period set by the Dispute Resolver (today the first half).
- Each answer needs the Kleros appeal fee plus a stake set by the Dispute Resolver.
- If both answers are fully funded, a new, larger jury decides the same question under this same policy, and the parties can add evidence.
- **If only one answer is fully funded when the appeal period ends, that answer wins the case, whatever the jurors voted.** If neither is fully funded, the vote stands.
- "Refuse to arbitrate" (option 0) can be funded like an answer. If it wins, it counts like "Did not attend".
- Only the **final ruling** counts: the ruling in force once the last appeal period has ended.
- Appeal money never passes through the event contract: the Dispute Resolver returns it, or pays rewards, to each funder under its own rules.

## What happens after the final ruling

- **Attended:** the challenger joins the attendance list and receives the same share of the pool as every attendee, plus what is left of both challenge deposits after the Kleros fee.
- **Did not attend:** the challenger stays off the list and their deposit is shared among the attendees. Whoever matched the challenge receives what is left of both challenge deposits.
- **Refused to arbitrate:** counts like "Did not attend" for the list; what is left of the challenge deposits is split equally between both sides.

Attendees can be paid before a dispute ends: one share is set aside for the challenger and handed out according to the final ruling. Once a challenge is in a dispute, the organiser can no longer add that person to the list directly; if the organiser agrees they attended, they say so in the case.

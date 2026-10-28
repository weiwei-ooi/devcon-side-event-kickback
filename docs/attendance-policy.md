# Truth Pays: attendance policy for Kleros jurors

This policy applies to disputes created by the Truth Pays deposit contract on Ethereum mainnet, through Kleros's Dispute Resolver in the Kleros Court. Each dispute asks one question: **did the person who registered with this wallet attend the event?** (The event is called "Truth Pays: Devcon Mumbai 2026" in the contract.)

## Which wallet a dispute is about

Each dispute has its own case description, which names the wallet concerned and the deposit contract. The deposit contract writes it when the challenge is matched, from a template fixed when the contract was deployed, so neither side chooses the wording.

- To check it on Etherscan: open the deposit contract's events and find the `ChallengeMatched` event whose `arbitratorDisputeID` is this case's number. Its `staker` field is the wallet concerned. The `Challenged` event for the same wallet shows when the challenge was made.
- If the evidence and the contract's events disagree, the contract's events are correct.

## The event

- **Truth Pays: Queryable Data, Prediction Markets & Onchain Justice**, a Devcon Mumbai side event (networking dinner).
- **When:** Wednesday 4 November 2026, 18:00–22:00 IST.
- **Where:** the venue announced to registered guests on Luma (planned: Hitchki, Bandra Kurla Complex (BKC), Mumbai).
- **Hosts:** Kleros, Arkiv (Golem Network) and Web3 Mumbai.
- Guests with a "Committed Spot" sent a refundable deposit in ETH on Ethereum mainnet (the amount is fixed in the contract as `depositAmount`). Guests who attend share the whole pool; no-shows lose their deposit.

## How a dispute starts

1. After the event the organiser publishes the list of depositors who checked in (Luma check-in at the door, plus any manual door list).
2. A depositor who is not on the list and says they attended has 1 day to challenge, paying an ETH deposit equal to the Kleros fee.
3. Anyone who believes the challenger did not attend has 1 day to match that deposit. Matching creates this dispute.

## Answers

- **Attended (option 1):** the person who registered with this wallet was present at the venue during the event.
- **Did not attend (option 2):** that person was not present, or the evidence does not make attendance more likely than not.

## How to decide

- The question is about the **person who registered with this wallet** on Luma, not about the wallet itself. Sending someone else in their place does not count as attending, unless the organiser approved the transfer of the spot before the event.
- Being present at the venue at any time between 18:00 and 22:00 IST on 4 November 2026 counts as attending. Arriving after 22:00 does not.
- The challenger must show that attendance is **more likely than not**. Not being scanned at the door is not, by itself, evidence of absence: Luma check-ins can be missed when the door is busy or the app is offline.
- Useful evidence includes: photos or videos taken at the venue during the event (ideally showing the person and something identifying the event or venue), messages or posts sent from the event, statements from hosts or other guests, receipts from the venue, and the organiser's door records.
- Evidence that is clearly edited, generated, or from another date or place should be ignored, and counts against the party who submitted it.
- If the organiser confirms in the case that the person attended, rule **Attended**.
- If neither side provides meaningful evidence, rule **Did not attend** (the challenger has not shown attendance).

## Appeals

- After each vote there is an appeal period (108 hours in the General Court today). Either side, or anyone else, can appeal by funding an answer on the Dispute Resolver.
- The answer the jurors voted for can be funded until the end of the appeal period. Any other answer (both answers, if the vote was tied or the jurors refused to arbitrate) can only be funded during the **first half** of the appeal period.
- Each answer needs the Kleros appeal fee plus a stake set by the Dispute Resolver. Today that is the fee plus 100% for the answer the jurors voted for, and the fee plus 200% for any other answer.
- If both answers are fully funded, a new, larger jury decides the same question under this same policy, and the parties can add evidence for the new round.
- **If only one answer is fully funded when the appeal period ends, that answer wins the case, whatever the jurors voted.** If neither is fully funded, the vote stands.
- Only the **final ruling** counts: the ruling in force once the last appeal period has ended. Earlier votes do not change the attendance list, the payouts or the challenge deposits.
- Appeal money is separate from the challenge deposits. Each funder pays it directly to the Dispute Resolver from their own wallet, and the Dispute Resolver returns it, or pays rewards, to that funder under its own appeal rules.

## What happens after the final ruling

- **Attended:** the challenger is added to the attendance list and receives the same share of the pool as every attendee. The challenger receives the remaining ETH deposits (both deposits minus the Kleros fee).
- **Did not attend:** the challenger stays off the list and forfeits their deposit, which is shared among the attendees. The party who matched the challenge receives the remaining ETH deposits.
- **Refused to arbitrate:** counts like "Did not attend": the challenger stays off the list and forfeits their deposit, and the remaining ETH is split equally between both parties.

Attendees can be paid before a dispute ends: the challenger's share is then set aside and handed out according to the final ruling. Once a challenge is in a dispute, the organiser can no longer add that person to the list directly; if the organiser agrees they attended, they say so in the case.

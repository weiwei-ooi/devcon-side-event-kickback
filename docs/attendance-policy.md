# Ground Truth: attendance policy for Kleros jurors

This policy applies to disputes created by the Ground Truth deposit contract on Arbitrum One. Each dispute asks one question: **did this wallet's owner attend the event?**

## The event

- **Ground Truth: Queryable Data, Prediction Markets & Decentralised Justice on Ethereum**, a Devcon Mumbai side event (networking dinner).
- **When:** Wednesday 4 November 2026, 18:00–22:00 IST.
- **Where:** Hitchki, Bandra Kurla Complex (BKC), Mumbai.
- **Hosts:** Kleros, Arkiv (Golem Network) and Web3 Mumbai.
- Guests with a "Committed Spot" sent a 25 USDC deposit. Guests who attend share the whole pool; no-shows lose their deposit.

## How a dispute starts

1. After the event the organiser publishes the list of depositors who checked in (Luma check-in at the door, plus any manual door list).
2. A depositor who is not on the list and says they attended has 1 day to challenge, paying an ETH deposit equal to the Kleros fee.
3. Anyone who believes the challenger did not attend has 1 day to match that deposit. Matching creates this dispute.

## Answers

- **Attended (1):** the wallet's owner was present at the venue during the event.
- **Did not attend (2):** the wallet's owner was not present, or the evidence does not make attendance more likely than not.

## How to decide

- The question is about the **person who registered with this wallet** on Luma, not about the wallet itself. Sending someone else in their place does not count as attending, unless the organiser approved the transfer of the spot before the event.
- Being present at the venue at any time between 18:00 and 22:00 IST on 4 November 2026 counts as attending. Arriving after 22:00 does not.
- The challenger must show that attendance is **more likely than not**. Not being scanned at the door is not, by itself, evidence of absence: Luma check-ins can be missed when the door is busy or the app is offline.
- Useful evidence includes: photos or videos taken at the venue during the event (ideally showing the person and something identifying the event or venue), messages or posts sent from the event, statements from hosts or other guests, receipts from the venue, and the organiser's door records.
- Evidence that is clearly edited, generated, or from another date or place should be ignored, and counts against the party who submitted it.
- If the organiser confirms in the case that the person attended, rule **Attended**.
- If neither side provides meaningful evidence, rule **Did not attend** (the challenger has not shown attendance).

## What happens after the ruling

- **Attended:** the challenger is added to the attendance list and shares the pool. The challenger receives the remaining ETH deposits (both deposits minus the Kleros fee).
- **Did not attend:** the challenger stays off the list. The party who matched the challenge receives the remaining ETH deposits.
- **Refused to arbitrate:** the challenger stays off the list and the remaining ETH is split equally between both parties.

Payouts to all attendees are released only once every dispute has been ruled and settled.

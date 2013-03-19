blobload
========

HTML5 file uploader using blob.

## Before you upload your blob
Create a temp(orary) and comp(leted) folder in the same directory as the app.js file.

## Checksum
Although there are proper javascript implementations of MD5 and other hashing algorithems, I think they are overkill for this usecase. You have to calculate the checksum server-side anyway, because you can't trust the client. I propose to just readout the middle half-megabyte of the files as text (UTF-8) and concatenate it with the total file size in bytes. This will be easier to calculate on the client and will serve the purpose just fine.


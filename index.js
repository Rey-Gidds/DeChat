const express = require('express');
const path = require('path')
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const { Socket } = require('dgram');
const io = new Server(server)

const rooms = {}
const roomColors = {}
const assignedColors = {}
const msg_index = {}

app.use(express.static(path.resolve('./public')))

app.get('/', (req, res) => {
  return res.sendFile('/public/index.html');
});



function assignColors(colors){
    return Math.floor(Math.random()*colors.length)
}

io.on('connection' , user => {
    user.on('joinRoom' , (roomKey) => {
        if(!rooms[roomKey]){
            rooms[roomKey] = {}
            roomColors[roomKey] = ['#00AFFF' , '#F5F5F0' , '#EE6666' , '#FFD700' , '#F2E68F' , '#00FFFF' , '#F87AA3' , '#C5F5CB']
            assignedColors[roomKey] = []
            msg_index[roomKey] = 0
        }
        else if(Object.keys(rooms[roomKey]).length >= 8) {
            user.emit('RoomLimitReached' , 'Cannot Connect room limit reached.')
            return
        }
        // of operator is used to directly access the elements of the array returned by the Object.keys(rooms) by their values.
        for (let room of Object.keys(rooms)) {
            console.log('Room the user was previously in.' , room)
            let usersInRoom = Object.keys(rooms[room]) // Object.keys() return an array that is why that array is stored in a seperate variable to use the .includes() method.
            if (usersInRoom.includes(user.id)) {
                delete rooms[roomKey]
                delete assignedColors[roomKey]
                delete msg_index[roomKey]
                delete roomColors[roomKey]
                console.log('Rooms: ' , rooms)
                user.emit('DoubleConnectionDenied')
                return;
            }
        }
        user.join(roomKey)
        let index = assignColors(roomColors[roomKey])

        io.to(roomKey).emit('TakeUserId' , user.id)

        rooms[roomKey][user.id] = roomColors[roomKey][index]


        if(index === roomColors[roomKey].length - 1){
            assignedColors[roomKey].push(roomColors[roomKey].pop())
        }
        else{
            let temp = roomColors[roomKey][index]
            roomColors[roomKey][index] = roomColors[roomKey][roomColors[roomKey].length - 1]
            roomColors[roomKey][roomColors[roomKey].length - 1] = temp
            assignedColors[roomKey].push(roomColors[roomKey].pop())
        }
        
        console.log(assignedColors)

        io.to(roomKey).emit('addMemberBall' , assignedColors[roomKey])

        console.log(roomColors , roomColors[roomKey].length)
        
        
        console.log('A Dechatter just Slid in.')

        user.on('editMsg' , (msg_index_for_edit , msg) => {
            let userColor = rooms[roomKey][user.id]
            io.to(roomKey).emit('msgEdited' , { msg , userColor } , user.id , msg_index_for_edit)
        })

        user.on('send_message' , (msg) => {
            let userColor = rooms[roomKey][user.id]
            console.log('Sender: ' , user.id)
            msg_index[roomKey]++
            io.to(roomKey).emit('message' , { msg , userColor } , user.id , msg_index[roomKey])
        })

        user.on('deleteMsg' , (msgToDel) => {
            io.to(roomKey).emit('delfromChatBox' , msgToDel)
        })

        user.on('disconnect' , () => {

            console.log('User Disconnected.')

            let userColor = rooms[roomKey][user.id]

            io.to(roomKey).emit('userDisconnected')

            io.to(roomKey).emit('removeMemberColorBall' , userColor)

            assignedColors[roomKey] = assignedColors[roomKey].filter((assignedColor) => { return assignedColor != userColor })

            console.log('Disconnected: ' , assignedColors[roomKey])

            roomColors[roomKey].push(userColor)

            delete rooms[roomKey][user.id]

            if(Object.keys(rooms[roomKey]).length === 0 || assignedColors[roomKey].length === 0){
                delete roomColors[roomKey]
                delete assignedColors[roomKey]
                delete rooms[roomKey]
                delete msg_index[roomKey]
            }
        })
    })
})



const PORT = process.env.PORT || 3000;
server.listen(PORT , () => {
    console.log(`Server started at PORT: ${PORT}`);
});

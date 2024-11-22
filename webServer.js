const mongoose = require("mongoose");
mongoose.Promise = require("bluebird");

const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const fs = require("fs");
const { makePasswordEntry, doesPasswordMatch } = require("./password");

const User = require("./schema/user.js");
const Photo = require("./schema/photo.js");
const SchemaInfo = require("./schema/schemaInfo.js");

mongoose.set("strictQuery", false);
mongoose.connect("mongodb://127.0.0.1/project6", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const app = express();
const processFormBody = multer({ storage: multer.memoryStorage() }).single(
  "uploadedphoto"
);

app.use(express.static(__dirname));
app.use(
  session({ secret: "secretKey", resave: false, saveUninitialized: false })
);
app.use(bodyParser.json());

// Middleware to check if user is logged in
const allowedPaths = ["/admin/login", "/user"];
app.use((req, res, next) => {
  if (!req.session.user && !allowedPaths.includes(req.path)) {
    return res.status(401).send("Unauthorized");
  } else {
    return next();
  }
});

// Route to handle user registration
app.post("/user", async (req, res) => {
  const {
    login_name,
    password,
    first_name,
    last_name,
    location,
    description,
    occupation,
  } = req.body;

  if (!login_name || !password || !first_name || !last_name) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const existingUser = await User.findOne({ login_name });
    if (existingUser) {
      return res.status(400).send("Login name already exists");
    }

    const passwordEntry = makePasswordEntry(password);

    const newUser = new User({
      login_name,
      password_digest: passwordEntry.hash,
      salt: passwordEntry.salt,
      first_name,
      last_name,
      location,
      description,
      occupation,
    });

    await newUser.save();
    return res.status(200).send({ login_name });
  } catch (err) {
    console.error("Error during user registration:", err);
    return res.status(500).send("Internal server error");
  }
});

// Route to handle user login
app.post("/admin/login", async (req, res) => {
  const { login_name, password } = req.body;

  if (!login_name || !password) {
    return res.status(400).send("Missing login name or password");
  }

  try {
    const user = await User.findOne({ login_name });
    if (
      !user ||
      !doesPasswordMatch(user.password_digest, user.salt, password)
    ) {
      return res.status(400).send("Invalid login credentials");
    }

    req.session.user = user;
    return res.send({ _id: user._id, first_name: user.first_name });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).send("Internal server error");
  }
});

// Route to handle user logout
app.post("/admin/logout", (req, res) => {
  if (!req.session.user) {
    return res.status(400).send("No user currently logged in");
  }

  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Internal server error");
    }

    // Clear the session cookie on the client side
    res.clearCookie("connect.sid"); // Ensure the session cookie is cleared

    return res.sendStatus(200);
  });
  return undefined;
});

// Middleware to check if user is logged in for specific routes
const requireLogin = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).send("Unauthorized");
  } else {
    return next();
  }
};

// Route to get SchemaInfo
app.get("/test/:p1", requireLogin, async function (request, response) {
  const param = request.params.p1 || "info";

  if (param === "info") {
    try {
      const info = await SchemaInfo.find({});
      if (info.length === 0) {
        return response.status(500).send("Missing SchemaInfo");
      }
      return response.json(info[0]);
    } catch (err) {
      return response.status(500).json(err);
    }
  } else if (param === "counts") {
    const collections = [
      { name: "user", collection: User },
      { name: "photo", collection: Photo },
      { name: "schemaInfo", collection: SchemaInfo },
    ];

    try {
      await Promise.all(
        collections.map(async (col) => {
          col.count = await col.collection.countDocuments({});
          return col;
        })
      );

      const obj = {};
      for (let i = 0; i < collections.length; i++) {
        obj[collections[i].name] = collections[i].count;
      }
      return response.json(obj);
    } catch (err) {
      return response.status(500).send(JSON.stringify(err));
    }
  } else {
    return response.status(400).send("Bad param " + param);
  }
});

// Route to upload a photo
app.post("/photos/new", (req, res) => {
  if (!req.session.user) {
    return res.status(401).send("Unauthorized");
  }

  processFormBody(req, res, async (uploadErr) => {
    if (uploadErr || !req.file) {
      return res.status(400).send("File upload error");
    }

    const timestamp = new Date().valueOf();
    const filename = "U" + timestamp + req.file.originalname;

    fs.writeFile(`./images/${filename}`, req.file.buffer, async (err) => {
      if (err) {
        return res.status(500).send("Failed to save the file");
      }

      const newPhoto = new Photo({
        file_name: filename,
        date_time: new Date(),
        user_id: req.session.user._id,
      });

      try {
        await newPhoto.save();
        return res.status(200).send("Photo uploaded successfully");
      } catch (saveErr) {
        console.error("Photo save error:", saveErr);
        return res.status(500).send("Failed to save photo in database");
      }
    });
    return undefined;
  });
  return undefined;
});

// Route to fetch user list
app.get("/user/list", requireLogin, async function (req, res) {
  try {
    const users = await User.find({}, "_id first_name last_name");
    return res.json(users);
  } catch (err) {
    console.error("Error fetching user list:", err);
    return res.status(500).send("Internal server error");
  }
});

// Route to fetch photos of a user
app.get("/photosOfUser/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).send({ message: "Invalid user ID format" });
    }

    const photos = await Photo.find({ user_id: userId })
      .select("_id user_id file_name date_time comments")
      .populate({
        path: "comments.user_id",
        model: "User",
        select: "_id first_name last_name",
      });

    if (!photos.length) {
      return res.status(400).send({ message: "No photos found for this user" });
    }

    const formattedPhotos = photos.map((photo) => ({
      _id: photo._id,
      user_id: photo.user_id,
      file_name: photo.file_name,
      date_time: photo.date_time,
      comments: photo.comments.map((comment) => ({
        _id: comment._id,
        comment: comment.comment,
        date_time: comment.date_time,
        user: {
          _id: comment.user_id?._id,
          first_name: comment.user_id?.first_name,
          last_name: comment.user_id?.last_name,
        },
      })),
    }));

    return res.status(200).json(formattedPhotos);
  } catch (error) {
    console.error("Error fetching photos for user:", error);
    return res.status(500).send({ message: "Server error fetching photos" });
  }
});

// Route to fetch a specific user
app.get("/user/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).send({ message: "Invalid user ID format" });
    }

    const user = await User.findById(
      userId,
      "_id first_name last_name location description occupation"
    );
    if (!user) {
      return res.status(400).send({ message: "User not found" });
    }
    res.status(200).json(user);
  } catch (error) {
    console.error("Error fetching user:", error);
    return res.status(500).send({ message: "Server error fetching user" });
  }
  return undefined;
});

// Add a comment to a photo
app.post("/commentsOfPhoto/:photo_id", async function (req, res) {
  const { photo_id } = req.params;
  const { comment } = req.body;

  if (!comment) {
    return res.status(400).send("Comment cannot be empty");
  }

  try {
    const photo = await Photo.findById(photo_id);
    if (!photo) {
      return res.status(404).send("Photo not found");
    }

    const newComment = {
      comment: comment,
      user_id: req.session.user._id,
      date_time: new Date(),
    };

    photo.comments.push(newComment);
    await photo.save();

    return res.status(200).send("Comment added successfully");
  } catch (err) {
    return res.status(500).send("Internal server error");
  }
});

app.get("/user/photoUsage/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).send({ message: "Invalid user ID format" });
    }

    const photos = await Photo.find({ user_id: userId });

    if (!photos.length) {
      return res.status(404).send({ message: "No photos found for this user" });
    }

    // Find the most recently uploaded photo
    const mostRecentPhoto = photos.reduce((latest, photo) => {
      return new Date(photo.date_time) > new Date(latest.date_time) ? photo : latest;
    }, photos[0]);

    // Find the photo with the most comments
    const photoWithMostComments = photos.reduce((maxComments, photo) => {
      return photo.comments.length > maxComments.comments.length ? photo : maxComments;
    }, photos[0]);

    const response = {
      mostRecentPhoto: {
        _id: mostRecentPhoto._id,
        file_name: mostRecentPhoto.file_name,
        date_time: mostRecentPhoto.date_time,
      },
      photoWithMostComments: {
        _id: photoWithMostComments._id,
        file_name: photoWithMostComments.file_name,
        commentsCount: photoWithMostComments.comments.length,
      },
    };

    res.status(200).json(response);
  } catch (err) {
    console.error("Error fetching photo usage details:", err);
    res.status(500).send({ message: "Internal server error" });
  }
});




// Start the server
const server = app.listen(3000, () => {
  console.log(`Listening on http://localhost:${server.address().port}`);
});
